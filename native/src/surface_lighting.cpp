#include "surface_lighting.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <thread>

namespace pp {
namespace {

constexpr size_t vertexStride = 4;

float exposureAt(
    RTCScene scene,
    const float* vertices,
    const std::array<float, 3>& direction,
    float bias) {
  const float* a = vertices;
  const float* b = vertices + vertexStride;
  const float* c = vertices + 2 * vertexStride;
  double u[3], v[3];
  for (int i = 0; i < 3; ++i) {
    u[i] = static_cast<double>(b[i]) - a[i];
    v[i] = static_cast<double>(c[i]) - a[i];
  }
  const double nx = u[1] * v[2] - u[2] * v[1];
  const double ny = u[2] * v[0] - u[0] * v[2];
  const double nz = u[0] * v[1] - u[1] * v[0];
  const double area = std::sqrt(nx * nx + ny * ny + nz * nz);
  const double light = nx * direction[0] + ny * direction[1] + nz * direction[2];
  if (!(light > 0.0) || !(area > 0.0)) return 0.0f;

  RTCRay ray{};
  ray.org_x = static_cast<float>((static_cast<double>(a[0]) + b[0] + c[0]) / 3.0);
  ray.org_y = static_cast<float>((static_cast<double>(a[1]) + b[1] + c[1]) / 3.0);
  ray.org_z = static_cast<float>((static_cast<double>(a[2]) + b[2] + c[2]) / 3.0);
  ray.tnear = bias;
  ray.dir_x = direction[0];
  ray.dir_y = direction[1];
  ray.dir_z = direction[2];
  ray.tfar = std::numeric_limits<float>::infinity();
  ray.mask = 0xffffffffu;
  rtcOccluded1(scene, &ray);
  return ray.tfar < 0.0f ? 0.0f : static_cast<float>(std::min(1.0, light / area));
}

}  // namespace

SurfaceLighting::~SurfaceLighting() {
  clear();
  if (device_) rtcReleaseDevice(device_);
}

void SurfaceLighting::clear() {
  batches_.clear();
  modelId_.clear();
  scoredDirection_ = {};
  std::vector<float>().swap(exposure_);
  if (scene_) {
    rtcReleaseScene(scene_);
    scene_ = nullptr;
  }
}

bool SurfaceLighting::prepare(const ModelRecord& model, const std::atomic<bool>& canceled) {
  if (scene_ && modelId_ == model.modelId) return true;
  clear();
  if (!device_) device_ = rtcNewDevice(nullptr);
  if (!device_) throw std::runtime_error("Embree could not initialize the CPU ray tracer.");

  RTCScene scene = rtcNewScene(device_);
  if (!scene) throw std::runtime_error("Embree could not allocate a lighting scene.");
  rtcSetSceneBuildQuality(scene, RTC_BUILD_QUALITY_MEDIUM);
  std::vector<Batch> batches;
  batches.reserve(model.batches.size());
  PickBatchCache source(1);

  try {
    for (const auto& batch : model.batches) {
      if (canceled.load(std::memory_order_relaxed)) break;
      const auto data = source.getOrLoad(batch.filePath);
      if (!data || data->faceIds.size() != batch.triangleCount) {
        throw std::runtime_error("An original mesh batch is unavailable for lighting.");
      }
      const size_t triangleCount = data->faceIds.size();
      RTCGeometry geometry = rtcNewGeometry(device_, RTC_GEOMETRY_TYPE_TRIANGLE);
      if (!geometry) throw std::runtime_error("Embree could not allocate a mesh batch.");
      rtcSetGeometryBuildQuality(geometry, RTC_BUILD_QUALITY_MEDIUM);
      float* positions = static_cast<float*>(rtcSetNewGeometryBuffer(
          geometry, RTC_BUFFER_TYPE_VERTEX, 0, RTC_FORMAT_FLOAT3, vertexStride * sizeof(float), triangleCount * 3));
      unsigned* indices = static_cast<unsigned*>(rtcSetNewGeometryBuffer(
          geometry, RTC_BUFFER_TYPE_INDEX, 0, RTC_FORMAT_UINT3, 3 * sizeof(unsigned), triangleCount));

      if (!positions || !indices) {
        rtcReleaseGeometry(geometry);
        throw std::runtime_error("Embree could not allocate original mesh buffers.");
      }

      for (size_t vertex = 0; vertex < triangleCount * 3; ++vertex) {
        std::copy_n(&data->positions[vertex * 3], 3, &positions[vertex * vertexStride]);
        positions[vertex * vertexStride + 3] = 0.0f;
        indices[vertex] = static_cast<unsigned>(vertex);
      }
      rtcCommitGeometry(geometry);
      unsigned id = rtcAttachGeometry(scene, geometry);
      rtcReleaseGeometry(geometry);
      if (id == RTC_INVALID_GEOMETRY_ID || rtcGetDeviceError(device_) != RTC_ERROR_NONE) {
        throw std::runtime_error("Embree could not attach a mesh batch.");
      }
      batches.push_back({positions, data->faceIds});
    }

    if (canceled.load(std::memory_order_relaxed)) {
      rtcReleaseScene(scene);
      return false;
    }

    rtcCommitScene(scene);
    if (rtcGetDeviceError(device_) != RTC_ERROR_NONE) {
      throw std::runtime_error("Embree could not build the full-resolution lighting scene.");
    }
    if (canceled.load(std::memory_order_relaxed)) {
      rtcReleaseScene(scene);
      return false;
    }

    modelId_ = model.modelId;
    batches_ = std::move(batches);
    scene_ = scene;
    return true;
  } catch (...) {
    rtcReleaseScene(scene);
    throw;
  }
}

bool SurfaceLighting::trace(
    const ModelRecord& model,
    const std::array<float, 3>& direction,
    const std::atomic<bool>& canceled) {
  if (!exposure_.empty() && scoredDirection_ == direction) return true;

  std::vector<float> result(model.triangleCount);
  float extent = 0.0f;
  for (size_t axis = 0; axis < 3; ++axis) {
    extent = std::max(extent, model.bounds.max[axis] - model.bounds.min[axis]);
  }
  const float bias = std::max(1e-7f, extent * 1e-6f);
  std::atomic<size_t> nextBatch = 0;
  auto sample = [&] {
    while (!canceled.load(std::memory_order_relaxed)) {
      const size_t index = nextBatch.fetch_add(1, std::memory_order_relaxed);
      if (index >= batches_.size()) break;
      const Batch& batch = batches_[index];
      for (size_t i = 0; i < batch.faceIds.size(); ++i) {
        if (i % 4096 == 0 && canceled.load(std::memory_order_relaxed)) return;
        const uint32_t id = batch.faceIds[i];
        if (id >= result.size()) continue;
        result[id] = exposureAt(scene_, &batch.vertices[i * 3 * vertexStride], direction, bias);
      }
    }
  };
  {
    const size_t concurrency = std::min({batches_.size(), size_t{16},
        static_cast<size_t>(std::max(1u, std::thread::hardware_concurrency()))});
    std::vector<std::jthread> threads;
    for (size_t i = 1; i < concurrency; ++i) threads.emplace_back(sample);
    sample();
  }
  if (canceled.load(std::memory_order_relaxed)) return false;
  scoredDirection_ = direction;
  exposure_ = std::move(result);
  return true;
}

std::string SurfaceLighting::writeExposure(
    const ModelRecord& model,
    const std::string& jobId,
    const std::array<float, 3>& direction,
    const std::atomic<bool>& canceled) {
  const double length = std::hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0.0) || !std::isfinite(length)) throw std::runtime_error("Invalid light direction.");
  const std::array<float, 3> normalized{
      static_cast<float>(direction[0] / length),
      static_cast<float>(direction[1] / length),
      static_cast<float>(direction[2] / length)};
  if (!prepare(model, canceled) || !trace(model, normalized, canceled) ||
      canceled.load(std::memory_order_relaxed)) return {};

  const auto path = std::filesystem::u8path(model.jobDir) / ("exposure-" + jobId + ".bin");
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) throw std::runtime_error("Could not write the exposure preview.");
  constexpr size_t chunkFaces = 65536;
  for (size_t offset = 0; offset < exposure_.size(); offset += chunkFaces) {
    if (canceled.load(std::memory_order_relaxed)) break;
    const size_t count = std::min(chunkFaces, exposure_.size() - offset);
    out.write(reinterpret_cast<const char*>(exposure_.data() + offset), count * sizeof(float));
  }
  out.close();
  if (!out || canceled.load(std::memory_order_relaxed)) {
    std::error_code ignored;
    std::filesystem::remove(path, ignored);
    if (canceled.load(std::memory_order_relaxed)) return {};
    throw std::runtime_error("Could not write the exposure preview.");
  }
  const auto utf8 = path.u8string();
  return std::string(utf8.begin(), utf8.end());
}

}  // namespace pp
