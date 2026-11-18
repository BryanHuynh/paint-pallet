#include "surface_topology.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <limits>
#include <numbers>
#include <stdexcept>

namespace pp {
namespace {

constexpr uint32_t noNeighbor = std::numeric_limits<uint32_t>::max();
using Vertex = std::array<uint32_t, 3>;

struct Edge {
  Vertex low;
  Vertex high;
  uint32_t face;
  uint32_t group;
  uint8_t side;
};

struct FillHit {
  uint32_t faceId;
  uint32_t batchIndex;
  uint32_t triangleIndex;
};

static_assert(sizeof(FillHit) == 3 * sizeof(uint32_t));

Vertex vertexBits(const float* position) {
  Vertex key;
  for (size_t axis = 0; axis < key.size(); ++axis) {
    key[axis] = position[axis] == 0.0f ? 0 : std::bit_cast<uint32_t>(position[axis]);
  }
  return key;
}

size_t edgePartition(const Vertex& low, const Vertex& high) {
  uint32_t hash = 2166136261u;
  for (uint32_t word : low) hash = (hash ^ word) * 16777619u;
  for (uint32_t word : high) hash = (hash ^ word) * 16777619u;
  return (hash ^ (hash >> 16)) & 255u;
}

std::array<float, 3> faceNormal(const float* positions) {
  double u[3], v[3];
  for (int i = 0; i < 3; ++i) {
    u[i] = static_cast<double>(positions[i + 3]) - positions[i];
    v[i] = static_cast<double>(positions[i + 6]) - positions[i];
  }
  double x = u[1] * v[2] - u[2] * v[1];
  double y = u[2] * v[0] - u[0] * v[2];
  double z = u[0] * v[1] - u[1] * v[0];
  double length = std::hypot(x, y, z);
  if (length == 0.0 || !std::isfinite(length)) return {};
  return {static_cast<float>(x / length), static_cast<float>(y / length), static_cast<float>(z / length)};
}

float normalDot(const std::array<float, 3>& a, const std::array<float, 3>& b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

}  // namespace

bool SurfaceTopology::matches(const ModelRecord& model) const {
  return !modelId_.empty() && modelId_ == model.modelId;
}

bool SurfaceTopology::build(const ModelRecord& model, const std::atomic<bool>& canceled) {
  clear();
  std::vector<Face> faces(model.triangleCount);
  for (auto& face : faces) {
    face.batchIndex = noNeighbor;
    std::fill(std::begin(face.neighbors), std::end(face.neighbors), noNeighbor);
  }

  std::vector<uint32_t> groups;
  if (!model.groupIdsPath.empty()) {
    groups.resize(faces.size());
    std::ifstream file(std::filesystem::u8path(model.groupIdsPath), std::ios::binary);
    if (!file.read(reinterpret_cast<char*>(groups.data()), groups.size() * sizeof(uint32_t))) {
      throw std::runtime_error("Original OBJ face groups are unavailable.");
    }
  }

  // Partition by the complete edge key so links are resolved across every spatial batch.
  std::array<std::vector<Edge>, 256> edgePartitions;
  PickBatchCache source(1);
  size_t faceCount = 0;
  for (const auto& batch : model.batches) {
    if (canceled.load(std::memory_order_relaxed)) return false;
    auto data = source.getOrLoad(batch.filePath);
    if (!data || data->faceIds.size() != batch.triangleCount) {
      throw std::runtime_error("Original mesh batch is unavailable.");
    }

    for (uint32_t local = 0; local < batch.triangleCount; ++local) {
      uint32_t faceId = data->faceIds[local];
      if (faceId >= faces.size() || faces[faceId].batchIndex != noNeighbor) {
        throw std::runtime_error("Original mesh face IDs are invalid.");
      }
      Face& face = faces[faceId];
      face.batchIndex = batch.batchIndex;
      face.triangleIndex = local;
      ++faceCount;

      const float* positions = &data->positions[static_cast<size_t>(local) * 9];
      face.normal = faceNormal(positions);
      if (face.normal == std::array<float, 3>{}) continue;
      Vertex vertices[3] = {vertexBits(positions), vertexBits(positions + 3), vertexBits(positions + 6)};

      for (uint8_t side = 0; side < 3; ++side) {
        const Vertex& a = vertices[side];
        const Vertex& b = vertices[(side + 1) % 3];
        const Vertex& low = std::min(a, b);
        const Vertex& high = std::max(a, b);
        const uint32_t group = groups.empty() ? 0 : groups[faceId];
        edgePartitions[edgePartition(low, high) ^ (group & 255u)].push_back({low, high, faceId, group, side});
      }
    }
  }

  if (faceCount != faces.size()) throw std::runtime_error("Original mesh faces are incomplete.");

  for (auto& partition : edgePartitions) {
    if (canceled.load(std::memory_order_relaxed)) return false;
    std::sort(partition.begin(), partition.end(), [](const Edge& a, const Edge& b) {
      if (a.group != b.group) return a.group < b.group;
      return a.low < b.low || (a.low == b.low && a.high < b.high);
    });
    for (size_t start = 0; start < partition.size();) {
      size_t end = start + 1;
      while (end < partition.size() && partition[start].group == partition[end].group &&
             partition[start].low == partition[end].low && partition[start].high == partition[end].high) {
        ++end;
      }

      // Ambiguous edges with more than two incident faces act as boundaries.
      if (end - start == 2) {
        const Edge& a = partition[start];
        const Edge& b = partition[start + 1];
        if (a.face != b.face) {
          faces[a.face].neighbors[a.side] = b.face;
          faces[b.face].neighbors[b.side] = a.face;
        }
      }
      start = end;
    }
    std::vector<Edge>().swap(partition);
  }

  if (canceled.load(std::memory_order_relaxed)) return false;
  modelId_ = model.modelId;
  faces_ = std::move(faces);
  return true;
}

std::string SurfaceTopology::writeConnectedFill(
    const ModelRecord& model,
    const std::string& jobId,
    uint32_t seed,
    double maxCreaseDegrees,
    const std::vector<uint32_t>& blockedFaces,
    const std::atomic<bool>& canceled) const {
  if (!matches(model) || seed >= faces_.size()) throw std::runtime_error("The fill seed is unavailable.");
  if (canceled.load(std::memory_order_relaxed)) return {};

  const double minDot = std::cos(std::clamp(maxCreaseDegrees, 0.0, 180.0) * std::numbers::pi / 180.0);
  std::vector<uint8_t> excluded(faces_.size());
  for (uint32_t id : blockedFaces) {
    if (id < excluded.size()) excluded[id] = 1;
  }

  std::vector<uint32_t> queue;
  if (!excluded[seed]) {
    queue.push_back(seed);
    excluded[seed] = 1;
  }
  for (size_t cursor = 0; cursor < queue.size(); ++cursor) {
    if (cursor % 4096 == 0 && canceled.load(std::memory_order_relaxed)) return {};
    const Face& face = faces_[queue[cursor]];
    for (uint32_t neighbor : face.neighbors) {
      if (neighbor == noNeighbor || excluded[neighbor]) continue;
      if (normalDot(face.normal, faces_[neighbor].normal) + 1.0e-6 < minDot) continue;
      excluded[neighbor] = 1;
      queue.push_back(neighbor);
    }
  }

  const auto filePath = std::filesystem::u8path(model.jobDir) / ("fill-" + jobId + ".bin");
  std::ofstream out(filePath, std::ios::binary | std::ios::trunc);
  if (!out) throw std::runtime_error("Could not write the connected fill preview.");

  std::array<FillHit, 4096> chunk;
  for (size_t start = 0; start < queue.size(); start += chunk.size()) {
    if (canceled.load(std::memory_order_relaxed)) break;
    const size_t size = std::min(chunk.size(), queue.size() - start);
    for (size_t i = 0; i < size; ++i) {
      const uint32_t id = queue[start + i];
      const Face& face = faces_[id];
      chunk[i] = {id, face.batchIndex, face.triangleIndex};
    }
    out.write(reinterpret_cast<const char*>(chunk.data()), size * sizeof(FillHit));
  }
  out.close();
  if (canceled.load(std::memory_order_relaxed) || !out) {
    std::error_code ignored;
    std::filesystem::remove(filePath, ignored);
    if (canceled.load(std::memory_order_relaxed)) return {};
    throw std::runtime_error("Could not write the connected fill preview.");
  }
  const auto utf8Path = filePath.u8string();
  return std::string(utf8Path.begin(), utf8Path.end());
}

void SurfaceTopology::clear() {
  modelId_.clear();
  std::vector<Face>().swap(faces_);
}

}  // namespace pp
