#include "surface_topology.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <limits>
#include <numbers>
#include <stdexcept>
#include <queue>

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
  bool forward;
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

uint8_t convexAngle(const Edge& a, const Edge& b,
                    const std::array<float, 3>& normalA, const std::array<float, 3>& normalB) {
  if (a.forward == b.forward) return 0;
  const Vertex& start = a.forward ? a.low : a.high;
  const Vertex& end = a.forward ? a.high : a.low;
  const double dx = static_cast<double>(std::bit_cast<float>(end[0])) - std::bit_cast<float>(start[0]);
  const double dy = static_cast<double>(std::bit_cast<float>(end[1])) - std::bit_cast<float>(start[1]);
  const double dz = static_cast<double>(std::bit_cast<float>(end[2])) - std::bit_cast<float>(start[2]);
  const double sign = dx * (normalA[1] * normalB[2] - normalA[2] * normalB[1]) +
                      dy * (normalA[2] * normalB[0] - normalA[0] * normalB[2]) +
                      dz * (normalA[0] * normalB[1] - normalA[1] * normalB[0]);
  if (sign <= std::hypot(dx, dy, dz) * 1e-6) return 0;
  const double radians = std::acos(std::clamp(normalDot(normalA, normalB), -1.0f, 1.0f));
  return static_cast<uint8_t>(std::lround(radians * 180 / std::numbers::pi));
}

float centerToSegment(const std::array<float, 3>& center, const float* a, const float* b) {
  double edge[3], offset[3];
  double projection = 0, length = 0;
  for (size_t i = 0; i < 3; ++i) {
    edge[i] = static_cast<double>(b[i]) - a[i];
    offset[i] = static_cast<double>(center[i]) - a[i];
    projection += offset[i] * edge[i];
    length += edge[i] * edge[i];
  }
  const double t = length > 0 ? std::clamp(projection / length, 0.0, 1.0) : 0;
  return static_cast<float>(std::hypot(offset[0] - t * edge[0], offset[1] - t * edge[1],
                                      offset[2] - t * edge[2]));
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
      for (size_t axis = 0; axis < 3; ++axis) {
        face.center[axis] = static_cast<float>((static_cast<double>(positions[axis]) +
                            positions[axis + 3] + positions[axis + 6]) / 3);
      }
      Vertex vertices[3] = {vertexBits(positions), vertexBits(positions + 3), vertexBits(positions + 6)};

      for (uint8_t side = 0; side < 3; ++side) {
        const Vertex& a = vertices[side];
        const Vertex& b = vertices[(side + 1) % 3];
        const Vertex& low = std::min(a, b);
        const Vertex& high = std::max(a, b);
        const uint32_t group = groups.empty() ? 0 : groups[faceId];
        face.edgeDistance[side] = centerToSegment(face.center, positions + side * 3,
                                                  positions + ((side + 1) % 3) * 3);
        edgePartitions[edgePartition(low, high) ^ (group & 255u)].push_back({low, high, faceId, group, side, a == low});
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
          const auto angle = convexAngle(a, b, faces[a.face].normal, faces[b.face].normal);
          faces[a.face].convexAngle[a.side] = angle;
          faces[b.face].convexAngle[b.side] = angle;
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
    bool coplanar,
    const std::atomic<bool>& canceled) const {
  if (!matches(model) || seed >= faces_.size()) throw std::runtime_error("The fill seed is unavailable.");
  if (canceled.load(std::memory_order_relaxed)) return {};

  const double minDot = std::cos(std::clamp(maxCreaseDegrees, 0.0, 180.0) * std::numbers::pi / 180.0);
  const auto& seedFace = faces_[seed];
  double span = 0;
  for (size_t axis = 0; axis < 3; ++axis) {
    span = std::max(span, static_cast<double>(model.bounds.max[axis]) - model.bounds.min[axis]);
  }
  const double planeTolerance = span * 1e-5;
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
      const auto& candidate = faces_[neighbor];
      if (normalDot(face.normal, candidate.normal) + 1.0e-6 < minDot) continue;
      if (coplanar) {
        const auto& normal = seedFace.normal;
        const double projection =
            normal[0] * (static_cast<double>(candidate.center[0]) - seedFace.center[0]) +
            normal[1] * (static_cast<double>(candidate.center[1]) - seedFace.center[1]) +
            normal[2] * (static_cast<double>(candidate.center[2]) - seedFace.center[2]);
        if (std::abs(projection) > planeTolerance || normalDot(normal, candidate.normal) + 1.0e-6 < minDot) continue;
      }
      excluded[neighbor] = 1;
      queue.push_back(neighbor);
    }
  }

  return writeHits(model, "fill-" + jobId + ".bin", queue, canceled);
}

std::string SurfaceTopology::writeRidgeBand(
    const ModelRecord& model, const std::string& jobId, double crease,
    double widthPercent, const std::string& regionPath, const std::atomic<bool>& canceled) const {
  if (!matches(model)) throw std::runtime_error("The ridge model is unavailable.");
  if (canceled.load(std::memory_order_relaxed)) return {};

  std::ifstream region(std::filesystem::u8path(regionPath), std::ios::binary | std::ios::ate);
  const auto bytes = region.tellg();
  if (bytes < 0 || bytes % sizeof(uint32_t) != 0 ||
      static_cast<uint64_t>(bytes) > faces_.size() * sizeof(uint32_t)) {
    throw std::runtime_error("Invalid ridge region faces.");
  }
  std::vector<uint32_t> ids(static_cast<size_t>(bytes) / sizeof(uint32_t));
  region.seekg(0);
  if (!region.read(reinterpret_cast<char*>(ids.data()), bytes)) {
    throw std::runtime_error("Cannot read ridge region faces.");
  }
  const float outside = -1;
  const auto infinity = std::numeric_limits<float>::infinity();
  std::vector<float> distance(faces_.size(), outside);
  for (uint32_t id : ids) {
    if (id >= distance.size()) throw std::runtime_error("Invalid ridge region face.");
    distance[id] = infinity;
  }

  double span = 0;
  for (size_t axis = 0; axis < 3; ++axis) {
    span = std::max(span, static_cast<double>(model.bounds.max[axis]) - model.bounds.min[axis]);
  }
  const double width = widthPercent * 0.01 * span;
  using QueueItem = std::pair<float, uint32_t>;
  std::priority_queue<QueueItem, std::vector<QueueItem>, std::greater<>> nearRidge;
  for (size_t i = 0; i < ids.size(); ++i) {
    if (i % 4096 == 0 && canceled.load(std::memory_order_relaxed)) return {};
    const uint32_t id = ids[i];
    const auto& face = faces_[id];
    float closest = infinity;
    for (size_t side = 0; side < 3; ++side) {
      const uint32_t neighbor = face.neighbors[side];
      if (neighbor != noNeighbor && distance[neighbor] != outside && face.convexAngle[side] >= crease) {
        closest = std::min(closest, face.edgeDistance[side]);
      }
    }
    if (closest < distance[id]) {
      distance[id] = closest;
      nearRidge.emplace(closest, id);
    }
  }

  std::vector<uint32_t> hits;
  while (!nearRidge.empty()) {
    if (hits.size() % 4096 == 0 && canceled.load(std::memory_order_relaxed)) return {};
    const auto [length, id] = nearRidge.top();
    nearRidge.pop();
    if (length != distance[id]) continue;
    hits.push_back(id);
    const auto& face = faces_[id];
    for (uint32_t neighbor : face.neighbors) {
      if (neighbor == noNeighbor || distance[neighbor] == outside) continue;
      const auto& other = faces_[neighbor].center;
      const auto& center = face.center;
      const float step = std::hypot(other[0] - center[0], other[1] - center[1], other[2] - center[2]);
      const float total = length + step;
      if (total <= width && total < distance[neighbor]) {
        distance[neighbor] = total;
        nearRidge.emplace(total, neighbor);
      }
    }
  }
  return writeHits(model, "ridges-" + jobId + ".bin", hits, canceled);
}

std::string SurfaceTopology::writeHits(
    const ModelRecord& model, std::string name, const std::vector<uint32_t>& hits,
    const std::atomic<bool>& canceled) const {
  const auto filePath = std::filesystem::u8path(model.jobDir) / name;
  std::ofstream out(filePath, std::ios::binary | std::ios::trunc);
  if (!out) throw std::runtime_error("Could not write the surface coverage preview.");

  std::array<FillHit, 4096> chunk;
  for (size_t start = 0; start < hits.size(); start += chunk.size()) {
    if (canceled.load(std::memory_order_relaxed)) break;
    const size_t size = std::min(chunk.size(), hits.size() - start);
    for (size_t i = 0; i < size; ++i) {
      const uint32_t id = hits[start + i];
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
    throw std::runtime_error("Could not write the surface coverage preview.");
  }
  const auto utf8Path = filePath.u8string();
  return std::string(utf8Path.begin(), utf8Path.end());
}

void SurfaceTopology::clear() {
  modelId_.clear();
  std::vector<Face>().swap(faces_);
}

}  // namespace pp
