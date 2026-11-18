#include "stl_importer.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <limits>
#include <memory>
#include <unordered_set>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

namespace fs = std::filesystem;

namespace pp {
namespace {

constexpr uint64_t kStlHeaderBytes = 84ULL;
constexpr uint64_t kStlRecordBytes = 50ULL;
constexpr uint64_t kMaxStlFileBytes = 2ULL * 1024ULL * 1024ULL * 1024ULL;  // 2 GiB
constexpr uint32_t kChunkTriangles = 65536;
constexpr uint32_t kStreamFlushTris = 4096;
constexpr uint32_t kPickChunkTris = 512;
constexpr uint32_t kPreviewMaxTriangles = 180000;
constexpr uint32_t kBatchMagic = 0x31425050;  // 'PPB1'

#ifdef _WIN32
std::wstring utf8ToWide(const std::string& utf8) {
  if (utf8.empty()) return {};
  int len = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), nullptr, 0);
  if (len <= 0) return {};
  std::wstring out(static_cast<size_t>(len), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), out.data(), len);
  return out;
}

std::string wideToUtf8(const std::wstring& w) {
  if (w.empty()) return {};
  int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (len <= 0) return {};
  std::string out(static_cast<size_t>(len), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), out.data(), len, nullptr, nullptr);
  return out;
}

inline fs::path utf8ToPath(const std::string& s) {
  return fs::path(utf8ToWide(s));
}

inline std::string pathToUtf8(const fs::path& p) {
  return wideToUtf8(p.wstring());
}

inline FILE* fopenUtf8(const std::string& pathUtf8, const wchar_t* mode) {
  return _wfopen(utf8ToWide(pathUtf8).c_str(), mode);
}

class Win64FileReader {
 public:
  explicit Win64FileReader(const std::string& pathUtf8) {
    std::wstring wpath = utf8ToWide(pathUtf8);
    handle_ = CreateFileW(
        wpath.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr);
    if (handle_ != INVALID_HANDLE_VALUE) {
      LARGE_INTEGER sz{};
      if (GetFileSizeEx(handle_, &sz)) {
        fileSize_ = static_cast<uint64_t>(sz.QuadPart);
      }
    }
  }

  ~Win64FileReader() {
    close();
  }

  Win64FileReader(const Win64FileReader&) = delete;
  Win64FileReader& operator=(const Win64FileReader&) = delete;

  void close() {
    if (handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
    }
  }

  bool isOpen() const { return handle_ != INVALID_HANDLE_VALUE; }
  uint64_t fileSize() const { return fileSize_; }

  bool seek64(uint64_t offset) {
    LARGE_INTEGER li{};
    li.QuadPart = static_cast<LONGLONG>(offset);
    return SetFilePointerEx(handle_, li, nullptr, FILE_BEGIN) != 0;
  }

  bool readExact(void* dst, size_t bytes, size_t* outRead = nullptr) {
    uint8_t* ptr = static_cast<uint8_t*>(dst);
    size_t total = 0;
    while (total < bytes) {
      DWORD toRead = static_cast<DWORD>(std::min<size_t>(bytes - total, 16u * 1024u * 1024u));
      DWORD readNow = 0;
      if (!ReadFile(handle_, ptr + total, toRead, &readNow, nullptr)) {
        if (outRead) *outRead = total;
        return false;
      }
      if (readNow == 0) {
        if (outRead) *outRead = total;
        return false;
      }
      total += readNow;
    }
    if (outRead) *outRead = total;
    return true;
  }

 private:
  HANDLE handle_ = INVALID_HANDLE_VALUE;
  uint64_t fileSize_ = 0;
};
#endif

struct PackedTri {
  float pos[9];
  float norm[9];
  uint32_t faceId;
};

struct SubBatchTemp {
  Bounds3 bounds{};
  uint32_t count = 0;
  std::string tempPath;
  bool spilledToDisk = false;
  std::vector<PackedTri> buffer;

  SubBatchTemp() {
    bounds.min[0] = bounds.min[1] = bounds.min[2] = std::numeric_limits<float>::infinity();
    bounds.max[0] = bounds.max[1] = bounds.max[2] = -std::numeric_limits<float>::infinity();
  }

  void close() {
    // Spill handles are opened and closed per flush so simultaneous open
    // native spill handles remain bounded (<= 1) even with hundreds of sub-batches.
  }

  void expandBounds(const float* p) {
    for (int k = 0; k < 3; ++k) {
      bounds.min[k] = std::min({bounds.min[k], p[k], p[3 + k], p[6 + k]});
      bounds.max[k] = std::max({bounds.max[k], p[k], p[3 + k], p[6 + k]});
    }
  }

  bool append(const PackedTri& tri) {
    expandBounds(tri.pos);
    ++count;
    buffer.push_back(tri);
    if (buffer.size() >= kStreamFlushTris) {
      return flush();
    }
    return true;
  }

  bool flush() {
    if (buffer.empty()) return true;
    FILE* f = fopenUtf8(tempPath, L"ab");
    if (!f) return false;
    size_t written = fwrite(buffer.data(), sizeof(PackedTri), buffer.size(), f);
    int closeRes = fclose(f);
    bool ok = (written == buffer.size()) && (closeRes == 0);
    spilledToDisk = true;
    buffer.clear();
    return ok;
  }
};

inline float readFloatLE(const uint8_t* p) {
  float v = 0.0f;
  std::memcpy(&v, p, sizeof(float));
  return v;
}

inline uint32_t readUInt32LE(const uint8_t* p) {
  uint32_t v = 0;
  std::memcpy(&v, p, sizeof(uint32_t));
  return v;
}

inline void computeFaceNormal(const float* pos, float* outN) {
  float ux = pos[3] - pos[0];
  float uy = pos[4] - pos[1];
  float uz = pos[5] - pos[2];
  float vx = pos[6] - pos[0];
  float vy = pos[7] - pos[1];
  float vz = pos[8] - pos[2];
  float nx = uy * vz - uz * vy;
  float ny = uz * vx - ux * vz;
  float nz = ux * vy - uy * vx;
  float len = std::sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-12f) {
    outN[0] = nx / len;
    outN[1] = ny / len;
    outN[2] = nz / len;
  } else {
    outN[0] = 0.0f;
    outN[1] = 0.0f;
    outN[2] = 1.0f;
  }
}

bool writeBatchFileFromPacked(const std::string& outPath, const std::vector<PackedTri>& tris) {
  FILE* f = fopenUtf8(outPath, L"wb");
  if (!f) return false;

  uint32_t header[4] = {kBatchMagic, 1u, static_cast<uint32_t>(tris.size()), 0u};
  if (fwrite(header, sizeof(uint32_t), 4, f) != 4) {
    fclose(f);
    return false;
  }

  const size_t n = tris.size();
  std::vector<float> posBuf(n * 9);
  std::vector<float> normBuf(n * 9);
  std::vector<uint32_t> idBuf(n);
  for (size_t i = 0; i < n; ++i) {
    std::memcpy(&posBuf[i * 9], tris[i].pos, 9 * sizeof(float));
    std::memcpy(&normBuf[i * 9], tris[i].norm, 9 * sizeof(float));
    idBuf[i] = tris[i].faceId;
  }

  bool ok = fwrite(posBuf.data(), sizeof(float), posBuf.size(), f) == posBuf.size() &&
            fwrite(normBuf.data(), sizeof(float), normBuf.size(), f) == normBuf.size() &&
            fwrite(idBuf.data(), sizeof(uint32_t), idBuf.size(), f) == idBuf.size();
  fclose(f);
  return ok;
}

/**
 * Finalizes a SubBatchTemp into a PPB1 file using bounded 4096-triangle chunked
 * streaming (never materializing the whole cell in memory).
 */
bool finalizeSubBatchStreaming(
    SubBatchTemp& sub,
    const std::string& outPath,
    const std::atomic<bool>& cancelFlag,
    bool* outCanceled) {
  *outCanceled = false;
  if (sub.count == 0) return true;
  if (!sub.spilledToDisk) {
    if (cancelFlag.load(std::memory_order_relaxed)) {
      *outCanceled = true;
      return false;
    }
    return writeBatchFileFromPacked(outPath, sub.buffer);
  }
  if (!sub.flush()) {
    return false;
  }

  FILE* in = fopenUtf8(sub.tempPath, L"rb");
  if (!in) return false;

  FILE* out = fopenUtf8(outPath, L"wb");
  if (!out) {
    fclose(in);
    return false;
  }

  uint32_t header[4] = {kBatchMagic, 1u, sub.count, 0u};
  if (fwrite(header, sizeof(uint32_t), 4, out) != 4) {
    fclose(in);
    fclose(out);
    return false;
  }

  std::vector<PackedTri> chunk(kStreamFlushTris);
  std::vector<float> floatChunk(kStreamFlushTris * 9);
  std::vector<uint32_t> idChunk(kStreamFlushTris);

  auto streamPass = [&](int fieldKind) -> bool {
    if (fseek(in, 0, SEEK_SET) != 0) return false;
    uint32_t remaining = sub.count;
    while (remaining > 0) {
      if (cancelFlag.load(std::memory_order_relaxed)) {
        *outCanceled = true;
        return false;
      }
      uint32_t take = std::min(remaining, kStreamFlushTris);
      if (fread(chunk.data(), sizeof(PackedTri), take, in) != take) return false;
      if (fieldKind == 0) {
        for (uint32_t i = 0; i < take; ++i) {
          std::memcpy(&floatChunk[i * 9], chunk[i].pos, 9 * sizeof(float));
        }
        if (fwrite(floatChunk.data(), sizeof(float), take * 9, out) != take * 9) return false;
      } else if (fieldKind == 1) {
        for (uint32_t i = 0; i < take; ++i) {
          std::memcpy(&floatChunk[i * 9], chunk[i].norm, 9 * sizeof(float));
        }
        if (fwrite(floatChunk.data(), sizeof(float), take * 9, out) != take * 9) return false;
      } else {
        for (uint32_t i = 0; i < take; ++i) {
          idChunk[i] = chunk[i].faceId;
        }
        if (fwrite(idChunk.data(), sizeof(uint32_t), take, out) != take) return false;
      }
      remaining -= take;
    }
    return true;
  };

  bool ok = streamPass(0) && streamPass(1) && streamPass(2);
  fclose(in);
  fclose(out);

  std::error_code ec;
  fs::remove(utf8ToPath(sub.tempPath), ec);
  return ok;
}

bool rayIntersectsBounds(
    const std::array<float, 3>& origin,
    const std::array<float, 3>& invDir,
    const Bounds3& b,
    float maxDist,
    float& outTMin) {
  float tmin = 0.0f;
  float tmax = maxDist;
  for (int i = 0; i < 3; ++i) {
    float t1 = (b.min[i] - origin[i]) * invDir[i];
    float t2 = (b.max[i] - origin[i]) * invDir[i];
    if (t1 > t2) std::swap(t1, t2);
    tmin = std::max(tmin, t1);
    tmax = std::min(tmax, t2);
    if (tmin > tmax) return false;
  }
  outTMin = tmin;
  return true;
}

bool rayTriangleMollerTrumbore(
    const std::array<float, 3>& orig,
    const std::array<float, 3>& dir,
    const float* v0,
    const float* v1,
    const float* v2,
    float& outT) {
  constexpr float kEps = 1e-7f;
  float e1[3] = {v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]};
  float e2[3] = {v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]};
  float h[3] = {
      dir[1] * e2[2] - dir[2] * e2[1],
      dir[2] * e2[0] - dir[0] * e2[2],
      dir[0] * e2[1] - dir[1] * e2[0],
  };
  float a = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  // Match Three.js FrontSide culling: reject backfaces (a <= 0) and grazing rays
  if (a <= kEps) return false;
  float f = 1.0f / a;
  float s[3] = {orig[0] - v0[0], orig[1] - v0[1], orig[2] - v0[2]};
  float u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
  if (u < 0.0f || u > 1.0f) return false;
  float q[3] = {
      s[1] * e1[2] - s[2] * e1[1],
      s[2] * e1[0] - s[0] * e1[2],
      s[0] * e1[1] - s[1] * e1[0],
  };
  float v = f * (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]);
  if (v < 0.0f || u + v > 1.0f) return false;
  float t = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
  if (t > kEps) {
    outT = t;
    return true;
  }
  return false;
}

}  // namespace

std::shared_ptr<const CachedBatchData> PickBatchCache::getOrLoad(const std::string& filePath) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = map_.find(filePath);
    if (it != map_.end()) {
      lruOrder_.splice(lruOrder_.begin(), lruOrder_, it->second.second);
      return it->second.first;
    }
  }

  FILE* f = fopenUtf8(filePath, L"rb");
  if (!f) return nullptr;

  uint32_t header[4]{};
  if (fread(header, sizeof(uint32_t), 4, f) != 4 || header[0] != kBatchMagic) {
    fclose(f);
    return nullptr;
  }
  const uint32_t n = header[2];
  auto data = std::make_shared<CachedBatchData>();
  data->positions.resize(static_cast<size_t>(n) * 9);
  if (fread(data->positions.data(), sizeof(float), data->positions.size(), f) != data->positions.size()) {
    fclose(f);
    return nullptr;
  }
  // Skip normals
  const int64_t skipBytes = static_cast<int64_t>(n) * 9LL * static_cast<int64_t>(sizeof(float));
  if (_fseeki64(f, skipBytes, SEEK_CUR) != 0) {
    fclose(f);
    return nullptr;
  }
  data->faceIds.resize(n);
  if (fread(data->faceIds.data(), sizeof(uint32_t), n, f) != n) {
    fclose(f);
    return nullptr;
  }
  fclose(f);

  const uint32_t numChunks = (n + kPickChunkTris - 1) / kPickChunkTris;
  data->chunkBounds.resize(numChunks);
  for (uint32_t c = 0; c < numChunks; ++c) {
    Bounds3 b{};
    b.min[0] = b.min[1] = b.min[2] = std::numeric_limits<float>::infinity();
    b.max[0] = b.max[1] = b.max[2] = -std::numeric_limits<float>::infinity();
    const uint32_t start = c * kPickChunkTris;
    const uint32_t end = std::min(n, start + kPickChunkTris);
    for (uint32_t i = start; i < end; ++i) {
      const float* p = &data->positions[static_cast<size_t>(i) * 9];
      for (int k = 0; k < 3; ++k) {
        b.min[k] = std::min({b.min[k], p[k], p[3 + k], p[6 + k]});
        b.max[k] = std::max({b.max[k], p[k], p[3 + k], p[6 + k]});
      }
    }
    data->chunkBounds[c] = b;
  }

  std::lock_guard<std::mutex> lock(mutex_);
  auto it = map_.find(filePath);
  if (it != map_.end()) {
    lruOrder_.splice(lruOrder_.begin(), lruOrder_, it->second.second);
    return it->second.first;
  }
  if (map_.size() >= maxEntries_ && !lruOrder_.empty()) {
    const std::string& victim = lruOrder_.back();
    map_.erase(victim);
    lruOrder_.pop_back();
  }
  lruOrder_.push_front(filePath);
  map_[filePath] = {data, lruOrder_.begin()};
  return data;
}

void PickBatchCache::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  map_.clear();
  lruOrder_.clear();
}

bool cleanupJobDir(const std::string& jobDirUtf8, std::string* outError) {
  if (jobDirUtf8.empty()) return true;
  std::error_code ec;
  fs::remove_all(utf8ToPath(jobDirUtf8), ec);
  if (ec) {
    if (outError) *outError = ec.message();
    return false;
  }
  return true;
}

ImportOutcome importBinaryStl(
    const std::string& filePathUtf8,
    const std::string& cacheDirUtf8,
    const std::string& jobId,
    const std::atomic<bool>& cancelFlag,
    const std::function<void(const ImportProgress&)>& onProgress) {
  ImportOutcome outcome;

  Win64FileReader reader(filePathUtf8);
  if (!reader.isOpen()) {
    outcome.errorMessage = "Could not open STL file: " + filePathUtf8;
    return outcome;
  }

  const uint64_t fileSize = reader.fileSize();
  if (fileSize < kStlHeaderBytes) {
    outcome.errorMessage = "Malformed STL: file is smaller than 84-byte binary STL header";
    return outcome;
  }
  if (fileSize > kMaxStlFileBytes) {
    outcome.errorMessage = "STL file exceeds 2 GiB limit";
    return outcome;
  }

  uint8_t header[kStlHeaderBytes]{};
  if (!reader.readExact(header, kStlHeaderBytes)) {
    outcome.errorMessage = "Malformed STL: failed to read 84-byte header";
    return outcome;
  }

  const uint32_t triangleCount = readUInt32LE(header + 80);
  if (triangleCount == 0) {
    outcome.errorMessage = "Malformed STL: triangle count is 0";
    return outcome;
  }

  const uint64_t expectedSize = kStlHeaderBytes + static_cast<uint64_t>(triangleCount) * kStlRecordBytes;
  if (fileSize != expectedSize) {
    outcome.errorMessage = "Truncated or malformed binary STL: expected " +
                           std::to_string(expectedSize) + " bytes for " +
                           std::to_string(triangleCount) + " triangles, got " +
                           std::to_string(fileSize) + " bytes";
    return outcome;
  }

  fs::path jobDir = utf8ToPath(cacheDirUtf8) / utf8ToPath("job_" + jobId);
  std::error_code ec;
  fs::create_directories(jobDir, ec);
  if (ec) {
    outcome.errorMessage = "Failed to create job cache directory: " + ec.message();
    return outcome;
  }
  const std::string jobDirUtf8 = pathToUtf8(jobDir);

  std::vector<std::unique_ptr<SubBatchTemp>> subBatches;
  auto closeAllHandles = [&]() {
    reader.close();
    for (auto& sb : subBatches) {
      if (sb) sb->close();
    }
  };

  auto failOrCancel = [&](bool canceled, const std::string& msg) -> ImportOutcome {
    closeAllHandles();
    std::string cleanErr;
    cleanupJobDir(jobDirUtf8, &cleanErr);
    outcome.ok = false;
    outcome.canceled = canceled;
    outcome.errorMessage = cleanErr.empty() ? msg : (msg + " (cleanup: " + cleanErr + ")");
    return outcome;
  };

  // Pass 1: stream chunks and compute global bounds
  Bounds3 globalBounds{};
  globalBounds.min[0] = globalBounds.min[1] = globalBounds.min[2] = std::numeric_limits<float>::infinity();
  globalBounds.max[0] = globalBounds.max[1] = globalBounds.max[2] = -std::numeric_limits<float>::infinity();

  std::vector<uint8_t> chunkBuf(static_cast<size_t>(kChunkTriangles) * kStlRecordBytes);
  uint32_t triIndex = 0;
  uint64_t bytesRead = kStlHeaderBytes;

  while (triIndex < triangleCount) {
    if (cancelFlag.load(std::memory_order_relaxed)) {
      return failOrCancel(true, "Import canceled");
    }
    const uint32_t countThisChunk = std::min(kChunkTriangles, triangleCount - triIndex);
    const size_t bytesThisChunk = static_cast<size_t>(countThisChunk) * kStlRecordBytes;
    if (!reader.readExact(chunkBuf.data(), bytesThisChunk)) {
      return failOrCancel(false, "Unexpected EOF while reading STL records");
    }

    for (uint32_t i = 0; i < countThisChunk; ++i) {
      const uint8_t* rec = chunkBuf.data() + static_cast<size_t>(i) * kStlRecordBytes;
      for (int v = 0; v < 3; ++v) {
        for (int k = 0; k < 3; ++k) {
          float coord = readFloatLE(rec + 12 + (v * 3 + k) * 4);
          globalBounds.min[k] = std::min(globalBounds.min[k], coord);
          globalBounds.max[k] = std::max(globalBounds.max[k], coord);
        }
      }
      ++triIndex;
    }

    bytesRead += bytesThisChunk;
    if (onProgress) {
      onProgress(ImportProgress{"reading", bytesRead, fileSize, triIndex, triangleCount});
    }
  }

  // Decide spatial grid dimensions based on triangle count
  uint32_t gridN = 1;
  if (triangleCount > 2000000u) {
    gridN = 6;
  } else if (triangleCount > 50000u) {
    gridN = 4;
  } else if (triangleCount > 2048u) {
    gridN = 2;
  }
  const uint32_t totalCells = gridN * gridN * gridN;

  // Each spatial cell points to an active sub-batch index in `subBatches`,
  // rolling over to a new sub-batch whenever `count == kMaxTrianglesPerBatch`
  // so skewed inputs remain strictly bounded.
  std::vector<int32_t> activeCellSubBatch(totalCells, -1);
  auto allocateSubBatch = [&]() -> int32_t {
    int32_t idx = static_cast<int32_t>(subBatches.size());
    auto sb = std::make_unique<SubBatchTemp>();
    char name[32];
    snprintf(name, sizeof(name), "sub_%05d.tmp", idx);
    sb->tempPath = pathToUtf8(jobDir / name);
    subBatches.push_back(std::move(sb));
    return idx;
  };

  float ext[3];
  for (int k = 0; k < 3; ++k) {
    ext[k] = std::max(1e-6f, globalBounds.max[k] - globalBounds.min[k]);
  }

  // Solid model-wide preview via streaming spatial vertex clustering when triangleCount > kPreviewMaxTriangles.
  // Unlike sparse triangle striding, vertex clustering preserves connected solid surfaces across the entire model
  // using O(occupied surface cells) memory.
  const bool buildClusterPreview = triangleCount > kPreviewMaxTriangles;
  constexpr uint32_t kPreviewGridMax = 128;
  const float previewMaxExt = std::max({ext[0], ext[1], ext[2]});
  const float previewCellSize = std::max(1e-6f, previewMaxExt / static_cast<float>(kPreviewGridMax));
  const uint32_t previewGx = std::max(1u, static_cast<uint32_t>(std::ceil(ext[0] / previewCellSize)));
  const uint32_t previewGy = std::max(1u, static_cast<uint32_t>(std::ceil(ext[1] / previewCellSize)));
  const uint32_t previewGz = std::max(1u, static_cast<uint32_t>(std::ceil(ext[2] / previewCellSize)));

  struct ClusterCell {
    double sumX = 0.0;
    double sumY = 0.0;
    double sumZ = 0.0;
    uint32_t count = 0;
  };
  struct ClusterTri {
    uint32_t c0, c1, c2;
  };
  struct ClusterTriKey {
    uint32_t a, b, c;
    bool operator==(const ClusterTriKey& o) const {
      return a == o.a && b == o.b && c == o.c;
    }
  };
  struct ClusterTriKeyHash {
    size_t operator()(const ClusterTriKey& k) const {
      uint64_t h = static_cast<uint64_t>(k.a) * 0x9e3779b97f4a7c15ULL;
      h ^= static_cast<uint64_t>(k.b) * 0xbf58476d1ce4e5b9ULL;
      h ^= static_cast<uint64_t>(k.c) * 0x94d049bb133111ebULL;
      return static_cast<size_t>(h ^ (h >> 30));
    }
  };

  std::unordered_map<uint64_t, uint32_t> previewCellToId;
  std::vector<ClusterCell> previewCells;
  std::unordered_set<ClusterTriKey, ClusterTriKeyHash> previewTriKeys;
  std::vector<ClusterTri> previewClusterTris;
  if (buildClusterPreview) {
    previewCellToId.reserve(65536);
    previewCells.reserve(65536);
    previewTriKeys.reserve(131072);
    previewClusterTris.reserve(131072);
  }

  auto getOrAddPreviewCell = [&](float x, float y, float z) -> uint32_t {
    uint32_t ix = std::min(previewGx - 1, static_cast<uint32_t>(std::max(0.0f, (x - globalBounds.min[0]) / previewCellSize)));
    uint32_t iy = std::min(previewGy - 1, static_cast<uint32_t>(std::max(0.0f, (y - globalBounds.min[1]) / previewCellSize)));
    uint32_t iz = std::min(previewGz - 1, static_cast<uint32_t>(std::max(0.0f, (z - globalBounds.min[2]) / previewCellSize)));
    uint64_t key = (static_cast<uint64_t>(ix) << 32) | (static_cast<uint64_t>(iy) << 16) | static_cast<uint64_t>(iz);
    auto [it, inserted] = previewCellToId.emplace(key, static_cast<uint32_t>(previewCells.size()));
    if (inserted) {
      previewCells.push_back(ClusterCell{x, y, z, 1});
    } else {
      ClusterCell& cell = previewCells[it->second];
      cell.sumX += x;
      cell.sumY += y;
      cell.sumZ += z;
      cell.count += 1;
    }
    return it->second;
  };

  if (!reader.seek64(kStlHeaderBytes)) {
    return failOrCancel(false, "Failed to seek STL stream for spatial batching");
  }

  triIndex = 0;
  bytesRead = kStlHeaderBytes;
  while (triIndex < triangleCount) {
    if (cancelFlag.load(std::memory_order_relaxed)) {
      return failOrCancel(true, "Import canceled");
    }
    const uint32_t countThisChunk = std::min(kChunkTriangles, triangleCount - triIndex);
    const size_t bytesThisChunk = static_cast<size_t>(countThisChunk) * kStlRecordBytes;
    if (!reader.readExact(chunkBuf.data(), bytesThisChunk)) {
      return failOrCancel(false, "Unexpected EOF during spatial batching");
    }

    for (uint32_t i = 0; i < countThisChunk; ++i) {
      const uint8_t* rec = chunkBuf.data() + static_cast<size_t>(i) * kStlRecordBytes;
      PackedTri pt{};
      for (int v = 0; v < 9; ++v) {
        pt.pos[v] = readFloatLE(rec + 12 + v * 4);
      }
      float fn[3];
      computeFaceNormal(pt.pos, fn);
      for (int k = 0; k < 3; ++k) {
        pt.norm[k] = fn[k];
        pt.norm[3 + k] = fn[k];
        pt.norm[6 + k] = fn[k];
      }
      pt.faceId = triIndex;

      uint32_t cellIdx = 0;
      if (gridN > 1) {
        float cx = (pt.pos[0] + pt.pos[3] + pt.pos[6]) / 3.0f;
        float cy = (pt.pos[1] + pt.pos[4] + pt.pos[7]) / 3.0f;
        float cz = (pt.pos[2] + pt.pos[5] + pt.pos[8]) / 3.0f;
        uint32_t ix = std::min(gridN - 1, static_cast<uint32_t>(std::max(0.0f, (cx - globalBounds.min[0]) / ext[0] * gridN)));
        uint32_t iy = std::min(gridN - 1, static_cast<uint32_t>(std::max(0.0f, (cy - globalBounds.min[1]) / ext[1] * gridN)));
        uint32_t iz = std::min(gridN - 1, static_cast<uint32_t>(std::max(0.0f, (cz - globalBounds.min[2]) / ext[2] * gridN)));
        cellIdx = (iz * gridN + iy) * gridN + ix;
      }

      int32_t sbIdx = activeCellSubBatch[cellIdx];
      if (sbIdx >= 0 && subBatches[sbIdx]->count >= kMaxTrianglesPerBatch) {
        if (!subBatches[sbIdx]->flush()) {
          return failOrCancel(false, "Failed flushing spatial batch temp file");
        }
        subBatches[sbIdx]->close();
        sbIdx = -1;
      }
      if (sbIdx < 0) {
        sbIdx = allocateSubBatch();
        activeCellSubBatch[cellIdx] = sbIdx;
      }

      if (!subBatches[sbIdx]->append(pt)) {
        return failOrCancel(false, "Failed writing spatial batch temp file");
      }

      if (buildClusterPreview) {
        uint32_t c0 = getOrAddPreviewCell(pt.pos[0], pt.pos[1], pt.pos[2]);
        uint32_t c1 = getOrAddPreviewCell(pt.pos[3], pt.pos[4], pt.pos[5]);
        uint32_t c2 = getOrAddPreviewCell(pt.pos[6], pt.pos[7], pt.pos[8]);
        if (c0 != c1 && c1 != c2 && c0 != c2) {
          uint32_t a = c0, b = c1, c = c2;
          if (a > b) std::swap(a, b);
          if (b > c) std::swap(b, c);
          if (a > b) std::swap(a, b);
          if (previewTriKeys.insert(ClusterTriKey{a, b, c}).second) {
            previewClusterTris.push_back(ClusterTri{c0, c1, c2});
          }
        }
      }
      ++triIndex;
    }

    bytesRead += bytesThisChunk;
    if (onProgress) {
      onProgress(ImportProgress{"batching", bytesRead, fileSize, triIndex, triangleCount});
    }
  }

  // Close STL input handle before finalization
  reader.close();

  std::vector<BatchDescriptor> batches;
  batches.reserve(subBatches.size());
  uint32_t finalizedTris = 0;
  for (size_t s = 0; s < subBatches.size(); ++s) {
    if (cancelFlag.load(std::memory_order_relaxed)) {
      return failOrCancel(true, "Import canceled");
    }
    auto& sb = *subBatches[s];
    if (sb.count == 0) continue;

    if (onProgress) {
      onProgress(ImportProgress{"finalizing", fileSize, fileSize, finalizedTris, triangleCount});
    }

    char name[32];
    snprintf(name, sizeof(name), "batch_%04u.bin", static_cast<uint32_t>(batches.size()));
    std::string outPath = pathToUtf8(jobDir / name);

    bool canceledDuringFin = false;
    if (!finalizeSubBatchStreaming(sb, outPath, cancelFlag, &canceledDuringFin)) {
      if (canceledDuringFin) {
        return failOrCancel(true, "Import canceled during finalization");
      }
      return failOrCancel(false, "Failed finalizing spatial batch file");
    }
    batches.push_back(BatchDescriptor{
        static_cast<uint32_t>(batches.size()),
        outPath,
        sb.count,
        sb.bounds,
    });
    finalizedTris += sb.count;
  }

  std::string previewPath;
  if (buildClusterPreview && !previewClusterTris.empty()) {
    if (cancelFlag.load(std::memory_order_relaxed)) {
      return failOrCancel(true, "Import canceled");
    }
    std::vector<PackedTri> previewTris;
    previewTris.reserve(previewClusterTris.size());
    for (uint32_t pIdx = 0; pIdx < static_cast<uint32_t>(previewClusterTris.size()); ++pIdx) {
      const ClusterTri& ct = previewClusterTris[pIdx];
      const ClusterCell& v0 = previewCells[ct.c0];
      const ClusterCell& v1 = previewCells[ct.c1];
      const ClusterCell& v2 = previewCells[ct.c2];
      PackedTri pt{};
      pt.pos[0] = static_cast<float>(v0.sumX / v0.count);
      pt.pos[1] = static_cast<float>(v0.sumY / v0.count);
      pt.pos[2] = static_cast<float>(v0.sumZ / v0.count);
      pt.pos[3] = static_cast<float>(v1.sumX / v1.count);
      pt.pos[4] = static_cast<float>(v1.sumY / v1.count);
      pt.pos[5] = static_cast<float>(v1.sumZ / v1.count);
      pt.pos[6] = static_cast<float>(v2.sumX / v2.count);
      pt.pos[7] = static_cast<float>(v2.sumY / v2.count);
      pt.pos[8] = static_cast<float>(v2.sumZ / v2.count);
      float fn[3];
      computeFaceNormal(pt.pos, fn);
      if (fn[0] == 0.0f && fn[1] == 0.0f && fn[2] == 0.0f) continue;
      for (int k = 0; k < 3; ++k) {
        pt.norm[k] = fn[k];
        pt.norm[3 + k] = fn[k];
        pt.norm[6 + k] = fn[k];
      }
      pt.faceId = pIdx;
      previewTris.push_back(pt);
    }
    previewCellToId.clear();
    previewCells.clear();
    previewTriKeys.clear();
    previewClusterTris.clear();

    if (!previewTris.empty()) {
      previewPath = pathToUtf8(jobDir / "preview.bin");
      if (!writeBatchFileFromPacked(previewPath, previewTris)) {
        return failOrCancel(false, "Failed writing preview batch");
      }
    }
  }

  if (onProgress) {
    onProgress(ImportProgress{"indexing", fileSize, fileSize, triangleCount, triangleCount});
  }

  outcome.ok = true;
  outcome.model.modelId = "model_" + jobId;
  outcome.model.partId = "part_0";
  outcome.model.fileName = pathToUtf8(utf8ToPath(filePathUtf8).filename());
  outcome.model.fileSizeBytes = fileSize;
  outcome.model.triangleCount = triangleCount;
  outcome.model.bounds = globalBounds;
  outcome.model.batches = std::move(batches);
  outcome.model.previewFilePath = previewPath;
  outcome.model.jobDir = jobDirUtf8;
  return outcome;
}

PickResult pickModelFace(
    const ModelRecord& model,
    const std::array<float, 3>& origin,
    const std::array<float, 3>& direction,
    PickBatchCache& cache,
    const std::vector<uint32_t>* allowedBatchIndices) {
  PickResult best{};
  float dirLen = std::sqrt(direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2]);
  if (dirLen < 1e-12f) return best;
  std::array<float, 3> dir{direction[0] / dirLen, direction[1] / dirLen, direction[2] / dirLen};
  std::array<float, 3> invDir{
      std::abs(dir[0]) > 1e-12f ? 1.0f / dir[0] : 1e30f,
      std::abs(dir[1]) > 1e-12f ? 1.0f / dir[1] : 1e30f,
      std::abs(dir[2]) > 1e-12f ? 1.0f / dir[2] : 1e30f,
  };

  float bestDist = std::numeric_limits<float>::infinity();
  float globalTMin = 0.0f;
  if (!rayIntersectsBounds(origin, invDir, model.bounds, bestDist, globalTMin)) {
    return best;
  }

  std::unordered_set<uint32_t> allowedSet;
  if (allowedBatchIndices) {
    allowedSet.reserve(allowedBatchIndices->size());
    for (uint32_t idx : *allowedBatchIndices) {
      allowedSet.insert(idx);
    }
  }

  struct CandidateBatch {
    size_t idx;
    float tMin;
  };
  std::vector<CandidateBatch> candidates;
  for (size_t i = 0; i < model.batches.size(); ++i) {
    if (allowedBatchIndices && allowedSet.find(model.batches[i].batchIndex) == allowedSet.end()) {
      continue;
    }
    float tMin = 0.0f;
    if (rayIntersectsBounds(origin, invDir, model.batches[i].bounds, bestDist, tMin)) {
      candidates.push_back(CandidateBatch{i, tMin});
    }
  }
  std::sort(candidates.begin(), candidates.end(), [](const CandidateBatch& a, const CandidateBatch& b) {
    return a.tMin < b.tMin;
  });

  for (const auto& cand : candidates) {
    if (cand.tMin > bestDist) break;
    const auto& batch = model.batches[cand.idx];
    auto data = cache.getOrLoad(batch.filePath);
    if (!data) continue;

    const uint32_t n = static_cast<uint32_t>(data->faceIds.size());
    const uint32_t numChunks = static_cast<uint32_t>(data->chunkBounds.size());
    for (uint32_t c = 0; c < numChunks; ++c) {
      float chunkTMin = 0.0f;
      if (!rayIntersectsBounds(origin, invDir, data->chunkBounds[c], bestDist, chunkTMin)) {
        continue;
      }
      const uint32_t start = c * kPickChunkTris;
      const uint32_t end = std::min(n, start + kPickChunkTris);
      for (uint32_t i = start; i < end; ++i) {
        const float* v0 = &data->positions[static_cast<size_t>(i) * 9];
        float t = 0.0f;
        if (rayTriangleMollerTrumbore(origin, dir, v0, v0 + 3, v0 + 6, t)) {
          if (t < bestDist) {
            bestDist = t;
            best.hit = true;
            best.partId = model.partId;
            best.originalFaceId = data->faceIds[i];
            best.distance = t;
            best.point = {origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t};
            computeFaceNormal(v0, best.normal.data());
          }
        }
      }
    }
  }

  return best;
}

}  // namespace pp
