#include "dxr_lighting.hpp"

#include <windows.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <stdexcept>

#include "exposure_shader.h"

namespace pp {
namespace {

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
double ms(Clock::time_point since) {
  return std::chrono::duration<double, std::milli>(Clock::now() - since).count();
}

void checked(HRESULT result, const char* action) {
  if (FAILED(result)) throw std::runtime_error(std::string(action) + " (" +
    std::to_string(static_cast<uint32_t>(result)) + ")");
}

constexpr D3D12_RESOURCE_STATES acceleration = D3D12_RESOURCE_STATE_RAYTRACING_ACCELERATION_STRUCTURE;
constexpr uint64_t bytesPerFace = 9 * sizeof(float);

uint64_t aligned(uint64_t value, uint64_t boundary) {
  return (value + boundary - 1) & ~(boundary - 1);
}

}  // namespace

class DxrLighting::Scene {
 public:
  Scene() = default;
  ~Scene() { if (event_) CloseHandle(event_); }

  void initialize() {
    ComPtr<IDXGIFactory6> factory;
    checked(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "Could not enumerate DirectX adapters");
    for (UINT index = 0;; index++) {
      ComPtr<IDXGIAdapter1> adapter;
      if (factory->EnumAdapterByGpuPreference(index, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
          IID_PPV_ARGS(&adapter)) == DXGI_ERROR_NOT_FOUND) break;
      if (!adapter) break;
      DXGI_ADAPTER_DESC1 desc{};
      if (FAILED(adapter->GetDesc1(&desc)) || (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) continue;
      ComPtr<ID3D12Device5> device;
      if (FAILED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_12_0, IID_PPV_ARGS(&device)))) continue;
      D3D12_FEATURE_DATA_D3D12_OPTIONS5 options{};
      D3D12_FEATURE_DATA_D3D12_OPTIONS precision{};
      D3D12_FEATURE_DATA_SHADER_MODEL shader{D3D_SHADER_MODEL_6_5};
      if (FAILED(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS5, &options, sizeof(options))) ||
          options.RaytracingTier < D3D12_RAYTRACING_TIER_1_1 ||
          FAILED(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS, &precision, sizeof(precision))) ||
          !precision.DoublePrecisionFloatShaderOps ||
          FAILED(device->CheckFeatureSupport(D3D12_FEATURE_SHADER_MODEL, &shader, sizeof(shader))) ||
          shader.HighestShaderModel < D3D_SHADER_MODEL_6_5 || FAILED(adapter.As(&adapter_))) continue;
      device_ = device;
      break;
    }
    if (!device_) throw std::runtime_error("DXR 1.1 and shader model 6.5 are unavailable");

    D3D12_COMMAND_QUEUE_DESC queueDesc{};
    queueDesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    checked(device_->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&queue_)), "Could not create the DXR queue");
    checked(device_->CreateCommandAllocator(queueDesc.Type, IID_PPV_ARGS(&allocator_)), "Could not allocate DXR commands");
    checked(device_->CreateCommandList(0, queueDesc.Type, allocator_.Get(), nullptr,
      IID_PPV_ARGS(&list_)), "Could not create the DXR command list");
    checked(device_->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence_)), "Could not create a DXR fence");
    event_ = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!event_) throw std::runtime_error("Could not create a DXR fence event");

    D3D12_ROOT_PARAMETER parameters[4]{};
    parameters[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_SRV;
    parameters[0].Descriptor.ShaderRegister = 0;
    parameters[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_SRV;
    parameters[1].Descriptor.ShaderRegister = 1;
    parameters[2].ParameterType = D3D12_ROOT_PARAMETER_TYPE_UAV;
    parameters[2].Descriptor.ShaderRegister = 0;
    parameters[3].ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    parameters[3].Constants = {0, 0, 6};
    D3D12_ROOT_SIGNATURE_DESC signatureDesc{};
    signatureDesc.NumParameters = 4;
    signatureDesc.pParameters = parameters;
    ComPtr<ID3DBlob> serialized;
    checked(D3D12SerializeRootSignature(&signatureDesc, D3D_ROOT_SIGNATURE_VERSION_1,
      &serialized, nullptr), "Could not create a DXR root signature");
    checked(device_->CreateRootSignature(0, serialized->GetBufferPointer(), serialized->GetBufferSize(),
      IID_PPV_ARGS(&signature_)), "Could not load the DXR root signature");

    D3D12_COMPUTE_PIPELINE_STATE_DESC compute{};
    compute.pRootSignature = signature_.Get();
    compute.CS = {g_exposureShader, sizeof(g_exposureShader)};
    checked(device_->CreateComputePipelineState(&compute, IID_PPV_ARGS(&pipeline_)), "Could not load the DXR exposure shader");
  }

  bool build(const ModelRecord& model, const std::atomic<bool>& canceled,
      bool limitBudget, DxrTimings& timing) {
    struct BottomLevel {
      D3D12_RAYTRACING_GEOMETRY_DESC geometry{};
      uint64_t vertexOffset = 0;
      uint64_t resultOffset = 0;
    };
    std::vector<BottomLevel> bottom;
    bottom.reserve(model.batches.size());
    uint64_t vertexBytes = 0, bottomBytes = 0, scratchBytes = 0;
    D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_INPUTS input{};
    input.Type = D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL;
    input.DescsLayout = D3D12_ELEMENTS_LAYOUT_ARRAY;
    input.Flags = D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_PREFER_FAST_TRACE;
    input.NumDescs = 1;
    for (const auto& batch : model.batches) {
      auto& item = bottom.emplace_back();
      item.geometry.Type = D3D12_RAYTRACING_GEOMETRY_TYPE_TRIANGLES;
      item.geometry.Flags = D3D12_RAYTRACING_GEOMETRY_FLAG_OPAQUE;
      auto& triangles = item.geometry.Triangles;
      triangles.VertexFormat = DXGI_FORMAT_R32G32B32_FLOAT;
      triangles.VertexCount = batch.triangleCount * 3;
      triangles.VertexBuffer.StrideInBytes = 3 * sizeof(float);
      input.pGeometryDescs = &item.geometry;
      D3D12_RAYTRACING_ACCELERATION_STRUCTURE_PREBUILD_INFO sizes{};
      device_->GetRaytracingAccelerationStructurePrebuildInfo(&input, &sizes);
      if (!sizes.ResultDataMaxSizeInBytes || !sizes.ScratchDataSizeInBytes) throw std::runtime_error("Invalid DXR batch sizes");
      item.vertexOffset = vertexBytes;
      item.resultOffset = bottomBytes;
      vertexBytes += batch.triangleCount * bytesPerFace;
      bottomBytes += aligned(sizes.ResultDataMaxSizeInBytes, D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BYTE_ALIGNMENT);
      scratchBytes = std::max(scratchBytes, sizes.ScratchDataSizeInBytes);
    }
    if (vertexBytes != model.triangleCount * bytesPerFace || bottom.empty()) throw std::runtime_error("Invalid DXR mesh batches");
    D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_INPUTS top{};
    top.Type = D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL;
    top.DescsLayout = D3D12_ELEMENTS_LAYOUT_ARRAY;
    top.Flags = input.Flags;
    top.NumDescs = static_cast<UINT>(bottom.size());
    D3D12_RAYTRACING_ACCELERATION_STRUCTURE_PREBUILD_INFO topSizes{};
    device_->GetRaytracingAccelerationStructurePrebuildInfo(&top, &topSizes);
    scratchBytes = std::max(scratchBytes, topSizes.ScratchDataSizeInBytes);
    const uint64_t scoreBytes = model.triangleCount * sizeof(float);
    const uint64_t total = vertexBytes + bottomBytes + topSizes.ResultDataMaxSizeInBytes + scratchBytes + scoreBytes;
    requireBudget(total, limitBudget, timing);
    if (canceled.load(std::memory_order_relaxed)) return false;

    positions_ = buffer(vertexBytes, D3D12_HEAP_TYPE_DEFAULT, D3D12_RESOURCE_STATE_COPY_DEST);
    bottom_ = buffer(bottomBytes, D3D12_HEAP_TYPE_DEFAULT, acceleration, true);
    top_ = buffer(topSizes.ResultDataMaxSizeInBytes, D3D12_HEAP_TYPE_DEFAULT, acceleration, true);
    auto scratch = buffer(scratchBytes, D3D12_HEAP_TYPE_DEFAULT, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, true);
    output_ = buffer(scoreBytes, D3D12_HEAP_TYPE_DEFAULT, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, true);
    readback_ = buffer(scoreBytes, D3D12_HEAP_TYPE_READBACK, D3D12_RESOURCE_STATE_COPY_DEST);
    recordUsage(timing);

    // Stream original positions to local memory using a reusable small staging buffer.
    uint64_t maxBatchBytes = 0;
    for (const auto& batch : model.batches) maxBatchBytes = std::max(maxBatchBytes, batch.triangleCount * bytesPerFace);
    constexpr size_t chunkBatches = 20;
    auto upload = buffer(maxBatchBytes * chunkBatches, D3D12_HEAP_TYPE_UPLOAD, D3D12_RESOURCE_STATE_GENERIC_READ);
    PickBatchCache data(1);
    ids_.reserve(model.triangleCount);
    D3D12_RANGE noRead{0, 0};
    for (size_t offset = 0; offset < bottom.size(); offset += chunkBatches) {
      if (canceled.load(std::memory_order_relaxed)) return false;
      const size_t end = std::min(bottom.size(), offset + chunkBatches);
      uint8_t* destination = nullptr;
      checked(upload->Map(0, &noRead, reinterpret_cast<void**>(&destination)), "Could not map original positions");
      for (size_t i = offset; i < end; i++) {
        const auto batch = data.getOrLoad(model.batches[i].filePath);
        if (!batch || batch->faceIds.size() != model.batches[i].triangleCount) {
          upload->Unmap(0, nullptr);
          throw std::runtime_error("Original mesh batches are unavailable for DXR");
        }
        const size_t bytes = batch->positions.size() * sizeof(float);
        const size_t chunkOffset = (i - offset) * maxBatchBytes;
        std::memcpy(destination + chunkOffset, batch->positions.data(), bytes);
        ids_.insert(ids_.end(), batch->faceIds.begin(), batch->faceIds.end());
        list_->CopyBufferRegion(positions_.Get(), bottom[i].vertexOffset, upload.Get(), chunkOffset, bytes);
      }
      upload->Unmap(0, nullptr);
      submit();
    }

    transition(positions_.Get(), D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    std::vector<D3D12_RAYTRACING_INSTANCE_DESC> instances(bottom.size());
    for (size_t i = 0; i < bottom.size(); i++) {
      if (canceled.load(std::memory_order_relaxed)) return false;
      auto& item = bottom[i];
      item.geometry.Triangles.VertexBuffer.StartAddress = positions_->GetGPUVirtualAddress() + item.vertexOffset;
      input.pGeometryDescs = &item.geometry;
      D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC build{};
      build.Inputs = input;
      build.ScratchAccelerationStructureData = scratch->GetGPUVirtualAddress();
      build.DestAccelerationStructureData = bottom_->GetGPUVirtualAddress() + item.resultOffset;
      list_->BuildRaytracingAccelerationStructure(&build, 0, nullptr);
      barrier(scratch.Get());
      auto& instance = instances[i];
      instance.Transform[0][0] = instance.Transform[1][1] = instance.Transform[2][2] = 1;
      instance.InstanceMask = 0xff;
      instance.AccelerationStructure = build.DestAccelerationStructureData;
      if ((i + 1) % chunkBatches == 0) submit();
    }
    barrier(bottom_.Get());

    const size_t instanceBytes = instances.size() * sizeof(instances[0]);
    auto instanceUpload = buffer(instanceBytes, D3D12_HEAP_TYPE_UPLOAD, D3D12_RESOURCE_STATE_GENERIC_READ);
    void* destination = nullptr;
    checked(instanceUpload->Map(0, &noRead, &destination), "Could not map DXR instances");
    std::memcpy(destination, instances.data(), instanceBytes);
    instanceUpload->Unmap(0, nullptr);
    top.InstanceDescs = instanceUpload->GetGPUVirtualAddress();
    D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC build{};
    build.Inputs = top;
    build.ScratchAccelerationStructureData = scratch->GetGPUVirtualAddress();
    build.DestAccelerationStructureData = top_->GetGPUVirtualAddress();
    list_->BuildRaytracingAccelerationStructure(&build, 0, nullptr);
    barrier(top_.Get());
    submit();
    recordUsage(timing);
    modelId = model.modelId;
    return !canceled.load(std::memory_order_relaxed);
  }

  bool trace(const ModelRecord& model, const std::array<float, 3>& rawDirection,
      const std::atomic<bool>& canceled, std::vector<float>& scores, DxrTimings& timing) {
    recordUsage(timing);
    if (timing.peakDedicatedBytes > timing.budget * 0.95) {
      throw std::runtime_error("Dedicated GPU memory budget has dropped");
    }
    const double length = std::hypot(rawDirection[0], rawDirection[1], rawDirection[2]);
    if (!(length > 0) || !std::isfinite(length)) throw std::runtime_error("Invalid DXR light direction");
    struct Constants { float x, y, z, bias; uint32_t first, count; };
    float extent = 0;
    for (size_t axis = 0; axis < 3; axis++) extent = std::max(extent, model.bounds.max[axis] - model.bounds.min[axis]);
    Constants constants{static_cast<float>(rawDirection[0] / length), static_cast<float>(rawDirection[1] / length),
        static_cast<float>(rawDirection[2] / length), std::max(1e-7f, extent * 1e-6f), 0, 0};
    const auto start = Clock::now();
    constexpr uint32_t dispatchFaces = 1u << 21;
    for (uint32_t first = 0; first < model.triangleCount; first += dispatchFaces) {
      if (canceled.load(std::memory_order_relaxed)) return false;
      constants.first = first;
      constants.count = std::min(dispatchFaces, model.triangleCount - first);
      list_->SetPipelineState(pipeline_.Get());
      list_->SetComputeRootSignature(signature_.Get());
      list_->SetComputeRootShaderResourceView(0, top_->GetGPUVirtualAddress());
      list_->SetComputeRootShaderResourceView(1, positions_->GetGPUVirtualAddress());
      list_->SetComputeRootUnorderedAccessView(2, output_->GetGPUVirtualAddress());
      list_->SetComputeRoot32BitConstants(3, 6, &constants, 0);
      list_->Dispatch((constants.count + 127) / 128, 1, 1);
      barrier(output_.Get());
      submit();
    }
    timing.dispatchMs = ms(start);

    const auto transfer = Clock::now();
    const size_t bytes = ids_.size() * sizeof(float);
    transition(output_.Get(), D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_STATE_COPY_SOURCE);
    list_->CopyBufferRegion(readback_.Get(), 0, output_.Get(), 0, bytes);
    transition(output_.Get(), D3D12_RESOURCE_STATE_COPY_SOURCE, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
    submit();
    if (canceled.load(std::memory_order_relaxed)) return false;
    D3D12_RANGE range{0, bytes};
    const float* data = nullptr;
    scores.resize(model.triangleCount);
    void* mapping = nullptr;
    checked(readback_->Map(0, &range, &mapping), "Could not read DXR exposure");
    data = static_cast<const float*>(mapping);
    for (size_t i = 0; i < ids_.size(); i++) if (ids_[i] < scores.size()) scores[ids_[i]] = data[i];
    D3D12_RANGE empty{0, 0};
    readback_->Unmap(0, &empty);
    timing.readbackMs = ms(transfer);
    recordUsage(timing);
    return true;
  }

  std::string modelId;

 private:
  void recordUsage(DxrTimings& timing) {
    DXGI_QUERY_VIDEO_MEMORY_INFO info{};
    checked(adapter_->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &info), "Could not query DXR memory usage");
    timing.budget = info.Budget;
    timing.peakDedicatedBytes = std::max(timing.peakDedicatedBytes, info.CurrentUsage);
  }
  void requireBudget(uint64_t bytes, bool limit, DxrTimings& timing) {
    DXGI_QUERY_VIDEO_MEMORY_INFO info{};
    checked(adapter_->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &info), "Could not query DXR memory budget");
    timing.budget = info.Budget;
    const auto remaining = info.Budget > info.CurrentUsage ? info.Budget - info.CurrentUsage : 0;
    if (limit || bytes > remaining * 0.85) throw std::runtime_error("Insufficient dedicated GPU memory for DXR");
  }
  ComPtr<ID3D12Resource> buffer(uint64_t bytes, D3D12_HEAP_TYPE heapType,
      D3D12_RESOURCE_STATES state, bool allowUav = false) {
    D3D12_HEAP_PROPERTIES heap{};
    heap.Type = heapType;
    heap.CreationNodeMask = heap.VisibleNodeMask = 1;
    D3D12_RESOURCE_DESC desc{};
    desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    desc.Width = bytes;
    desc.Height = 1;
    desc.DepthOrArraySize = desc.MipLevels = 1;
    desc.SampleDesc.Count = 1;
    desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    desc.Flags = allowUav ? D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS : D3D12_RESOURCE_FLAG_NONE;
    ComPtr<ID3D12Resource> resource;
    checked(device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &desc, state,
      nullptr, IID_PPV_ARGS(&resource)), "Could not allocate a DXR buffer");
    return resource;
  }
  void barrier(ID3D12Resource* resource) {
    D3D12_RESOURCE_BARRIER value{};
    value.Type = D3D12_RESOURCE_BARRIER_TYPE_UAV;
    value.UAV.pResource = resource;
    list_->ResourceBarrier(1, &value);
  }
  void transition(ID3D12Resource* resource, D3D12_RESOURCE_STATES before, D3D12_RESOURCE_STATES after) {
    D3D12_RESOURCE_BARRIER value{};
    value.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    value.Transition = {resource, D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES, before, after};
    list_->ResourceBarrier(1, &value);
  }
  void submit() {
    checked(list_->Close(), "Could not close DXR commands");
    ID3D12CommandList* commands[] = {list_.Get()};
    queue_->ExecuteCommandLists(1, commands);
    checked(queue_->Signal(fence_.Get(), ++sequence_), "Could not signal DXR completion");
    if (fence_->GetCompletedValue() < sequence_) {
      checked(fence_->SetEventOnCompletion(sequence_, event_), "Could not wait for DXR completion");
      if (WaitForSingleObject(event_, 60000) != WAIT_OBJECT_0) throw std::runtime_error("DXR commands did not complete");
    }
    checked(device_->GetDeviceRemovedReason(), "DXR device was removed");
    checked(allocator_->Reset(), "Could not reset DXR allocator");
    checked(list_->Reset(allocator_.Get(), nullptr), "Could not reset DXR commands");
  }

  ComPtr<IDXGIAdapter3> adapter_;
  ComPtr<ID3D12Device5> device_;
  ComPtr<ID3D12CommandQueue> queue_;
  ComPtr<ID3D12CommandAllocator> allocator_;
  ComPtr<ID3D12GraphicsCommandList4> list_;
  ComPtr<ID3D12Fence> fence_;
  ComPtr<ID3D12RootSignature> signature_;
  ComPtr<ID3D12PipelineState> pipeline_;
  ComPtr<ID3D12Resource> positions_, bottom_, top_, output_, readback_;
  std::vector<uint32_t> ids_;
  HANDLE event_ = nullptr;
  uint64_t sequence_ = 0;
};

DxrLighting::DxrLighting() = default;
DxrLighting::~DxrLighting() = default;
void DxrLighting::clear() { scene_.reset(); }

bool DxrLighting::compute(const ModelRecord& model, const std::array<float, 3>& direction,
    const std::atomic<bool>& canceled, const std::string& option,
    std::vector<float>& scores, DxrTimings& timing) {
  if (option == "simulate-unsupported") throw std::runtime_error("DXR capability unavailable (benchmark simulation)");
  if (option == "simulate-failure") throw std::runtime_error("DXR device failure (benchmark simulation)");
  if (canceled.load(std::memory_order_relaxed)) return false;
  if (!scene_ || scene_->modelId != model.modelId || option == "simulate-low-memory") {
    const auto start = Clock::now();
    scene_.reset();
    auto next = std::make_unique<Scene>();
    next->initialize();
    if (!next->build(model, canceled, option == "simulate-low-memory", timing)) return false;
    scene_ = std::move(next);
    timing.setupMs = ms(start);
  }
  return scene_->trace(model, direction, canceled, scores, timing);
}

}  // namespace pp
