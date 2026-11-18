#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <list>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace pp {

constexpr uint32_t kMaxTrianglesPerBatch = 65536;

struct Bounds3 {
  float min[3];
  float max[3];
};

struct BatchDescriptor {
  uint32_t batchIndex;
  std::string filePath;
  uint32_t triangleCount;
  Bounds3 bounds;
};

struct ModelRecord {
  std::string modelId;
  std::string partId;
  std::string fileName;
  uint64_t fileSizeBytes = 0;
  uint32_t triangleCount = 0;
  Bounds3 bounds{};
  std::vector<BatchDescriptor> batches;
  std::string previewFilePath;
  std::string jobDir;
};

struct ImportProgress {
  std::string phase;
  uint64_t bytesRead = 0;
  uint64_t totalBytes = 0;
  uint32_t trianglesRead = 0;
  uint32_t totalTriangles = 0;
};

struct ImportOutcome {
  bool ok = false;
  bool canceled = false;
  std::string errorMessage;
  ModelRecord model;
};

struct PickResult {
  bool hit = false;
  std::string partId;
  uint32_t originalFaceId = 0;
  float distance = 0.0f;
  std::array<float, 3> point{0.0f, 0.0f, 0.0f};
  std::array<float, 3> normal{0.0f, 0.0f, 0.0f};
};

struct CachedBatchData {
  std::vector<float> positions;
  std::vector<uint32_t> faceIds;
  std::vector<Bounds3> chunkBounds;  // 1 AABB per 512 triangles
};

class PickBatchCache {
 public:
  explicit PickBatchCache(size_t maxEntries = 16) : maxEntries_(maxEntries) {}

  std::shared_ptr<const CachedBatchData> getOrLoad(const std::string& filePath);
  void clear();

 private:
  size_t maxEntries_;
  std::mutex mutex_;
  std::list<std::string> lruOrder_;
  std::unordered_map<std::string, std::pair<std::shared_ptr<const CachedBatchData>, std::list<std::string>::iterator>> map_;
};

ImportOutcome importBinaryStl(
    const std::string& filePathUtf8,
    const std::string& cacheDirUtf8,
    const std::string& jobId,
    const std::atomic<bool>& cancelFlag,
    const std::function<void(const ImportProgress&)>& onProgress);

PickResult pickModelFace(
    const ModelRecord& model,
    const std::array<float, 3>& origin,
    const std::array<float, 3>& direction,
    PickBatchCache& cache,
    const std::vector<uint32_t>* allowedBatchIndices = nullptr);

bool cleanupJobDir(const std::string& jobDirUtf8, std::string* outError = nullptr);

}  // namespace pp
