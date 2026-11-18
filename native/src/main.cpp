#include "protocol.hpp"
#include "stl_importer.hpp"
#include "surface_topology.hpp"
#include "surface_lighting.hpp"
#include "dxr_lighting.hpp"
#include <chrono>

#include <atomic>
#include <cctype>
#include <cmath>
#include <condition_variable>
#include <filesystem>
#include <iostream>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace {

std::mutex g_outMutex;

void emitLine(const std::string& line) {
  std::lock_guard<std::mutex> lock(g_outMutex);
  std::cout << line << '\n' << std::flush;
}

bool isValidJobId(const std::string& jobId) {
  if (jobId.empty() || jobId.size() > 64) return false;
  for (unsigned char c : jobId) {
    if (!std::isalnum(c) && c != '_' && c != '-') return false;
  }
  return true;
}

std::string formatVec3(const float* v) {
  char buf[128];
  snprintf(buf, sizeof(buf), "[%.9g,%.9g,%.9g]", v[0], v[1], v[2]);
  return std::string(buf);
}

std::string formatBounds(const pp::Bounds3& b) {
  return "{\"min\":" + formatVec3(b.min) + ",\"max\":" + formatVec3(b.max) + "}";
}

std::string formatModelJson(const pp::ModelRecord& m) {
  std::string s = "{";
  s += "\"modelId\":\"" + pp::jsonEscape(m.modelId) + "\",";
  s += "\"partId\":\"" + pp::jsonEscape(m.partId) + "\",";
  s += "\"fileName\":\"" + pp::jsonEscape(m.fileName) + "\",";
  s += "\"fileSizeBytes\":" + std::to_string(m.fileSizeBytes) + ",";
  s += "\"triangleCount\":" + std::to_string(m.triangleCount) + ",";
  s += "\"bounds\":" + formatBounds(m.bounds) + ",";
  if (m.previewFilePath.empty()) {
    s += "\"previewFilePath\":null,";
  } else {
    s += "\"previewFilePath\":\"" + pp::jsonEscape(m.previewFilePath) + "\",";
  }
  s += "\"batches\":[";
  for (size_t i = 0; i < m.batches.size(); ++i) {
    if (i > 0) s += ",";
    const auto& b = m.batches[i];
    s += "{\"batchIndex\":" + std::to_string(b.batchIndex) +
         ",\"filePath\":\"" + pp::jsonEscape(b.filePath) + "\"" +
         ",\"triangleCount\":" + std::to_string(b.triangleCount) +
         ",\"bounds\":" + formatBounds(b.bounds) + "}";
  }
  s += "]}";
  return s;
}

void restoreOriginalSource(const std::string& line, pp::ImportOutcome& outcome) {
  const auto name = pp::extractJsonString(line, "sourceName");
  if (!outcome.ok || !name) return;
  const auto metadata = pp::extractJsonNumberArray(line, "sourceMeta");
  if (!metadata || metadata->size() != 1 || !((*metadata)[0] >= 0 && (*metadata)[0] <= 2147483648.0)) {
    throw std::runtime_error("Invalid original model metadata.");
  }

  outcome.model.fileName = *name;
  outcome.model.fileSizeBytes = static_cast<uint64_t>((*metadata)[0]);
  const auto sourceGroups = pp::extractJsonString(line, "sourceGroups");
  if (!sourceGroups) return;

  const auto ids = std::filesystem::u8path(*sourceGroups);
  const auto names = pp::extractJsonString(line, "sourceGroupNames");
  if (!names || std::filesystem::file_size(ids) != static_cast<uint64_t>(outcome.model.triangleCount) * 4) {
    throw std::runtime_error("Could not preserve the OBJ groups.");
  }

  const auto dir = std::filesystem::u8path(outcome.model.jobDir);
  const auto destination = dir / "face-groups.bin";
  std::filesystem::copy_file(ids, destination);
  std::filesystem::copy_file(std::filesystem::u8path(*names), dir / "group-names.json");
  const auto destinationUtf8 = destination.u8string();
  outcome.model.groupIdsPath.assign(destinationUtf8.begin(), destinationUtf8.end());
}

struct QueuedJob {
  std::string line;
  std::shared_ptr<std::atomic<bool>> cancelFlag;
};

struct WorkerState {
  std::mutex jobsMutex;
  std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> pendingOrRunningJobs;
  std::unordered_map<std::string, pp::ModelRecord> models;
  std::string activeModelId;
  pp::PickBatchCache pickCache{16};
  pp::SurfaceTopology topology;
  pp::SurfaceLighting lighting;
  pp::DxrLighting dxr;
};

}  // namespace

int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);

  WorkerState state;
  std::mutex queueMutex;
  std::condition_variable queueCv;
  std::queue<QueuedJob> jobQueue;
  bool shuttingDown = false;

  std::thread workerThread([&]() {
    while (true) {
      QueuedJob job;
      {
        std::unique_lock<std::mutex> lock(queueMutex);
        queueCv.wait(lock, [&]() { return shuttingDown || !jobQueue.empty(); });
        if (shuttingDown && jobQueue.empty()) break;
        job = std::move(jobQueue.front());
        jobQueue.pop();
      }

      const std::string& line = job.line;
      auto cmdOpt = pp::extractJsonString(line, "cmd");
      if (!cmdOpt) continue;
      const std::string& cmd = *cmdOpt;
      const std::string reqId = pp::extractJsonString(line, "reqId").value_or("");

      if (cmd == "import") {
        const std::string jobId = pp::extractJsonString(line, "jobId").value_or("");
        const std::string filePath = pp::extractJsonString(line, "filePath").value_or("");
        const std::string cacheDir = pp::extractJsonString(line, "cacheDir").value_or(".");
        const bool staged = pp::extractJsonBool(line, "staged").value_or(false);

        if (!isValidJobId(jobId)) {
          std::lock_guard<std::mutex> lock(state.jobsMutex);
          state.pendingOrRunningJobs.erase(jobId);
          emitLine("{\"type\":\"import_error\",\"reqId\":\"" + pp::jsonEscape(reqId) +
                   "\",\"jobId\":\"" + pp::jsonEscape(jobId) +
                   "\",\"error\":\"Invalid jobId\"}");
          continue;
        }

        auto cancelFlag = job.cancelFlag;
        if (!cancelFlag) {
          cancelFlag = std::make_shared<std::atomic<bool>>(false);
        }

        pp::ImportOutcome outcome;
        if (cancelFlag->load(std::memory_order_relaxed)) {
          outcome.ok = false;
          outcome.canceled = true;
        } else {
          outcome = pp::importBinaryStl(filePath, cacheDir, jobId, *cancelFlag, [&](const pp::ImportProgress& p) {
            emitLine("{\"type\":\"progress\",\"jobId\":\"" + pp::jsonEscape(jobId) +
                     "\",\"phase\":\"" + pp::jsonEscape(p.phase) +
                     "\",\"bytesRead\":" + std::to_string(p.bytesRead) +
                     ",\"totalBytes\":" + std::to_string(p.totalBytes) +
                     ",\"trianglesRead\":" + std::to_string(p.trianglesRead) +
                     ",\"totalTriangles\":" + std::to_string(p.totalTriangles) + "}");
          });
          try {
            restoreOriginalSource(line, outcome);
          } catch (const std::exception& error) {
            pp::cleanupJobDir(outcome.model.jobDir);
            outcome.ok = false;
            outcome.errorMessage = error.what();
          }
        }

        {
          std::vector<std::string> dirsToCleanup;
          {
            std::lock_guard<std::mutex> lock(state.jobsMutex);
            state.pendingOrRunningJobs.erase(jobId);
            if (outcome.ok) {
              if (!staged) {
                for (auto it = state.models.begin(); it != state.models.end();) {
                  if (it->first != outcome.model.modelId) {
                    dirsToCleanup.push_back(it->second.jobDir);
                    it = state.models.erase(it);
                  } else {
                    ++it;
                  }
                }
                state.activeModelId = outcome.model.modelId;
                state.pickCache.clear();
                state.topology.clear();
                state.lighting.clear();
                state.dxr.clear();
              }
              state.models[outcome.model.modelId] = outcome.model;
            }
          }
          for (const auto& d : dirsToCleanup) {
            pp::cleanupJobDir(d);
          }
        }

        if (outcome.ok) {
          emitLine("{\"type\":\"import_complete\",\"reqId\":\"" + pp::jsonEscape(reqId) +
                   "\",\"jobId\":\"" + pp::jsonEscape(jobId) +
                   "\",\"model\":" + formatModelJson(outcome.model) + "}");
        } else if (outcome.canceled) {
          emitLine("{\"type\":\"import_canceled\",\"reqId\":\"" + pp::jsonEscape(reqId) +
                   "\",\"jobId\":\"" + pp::jsonEscape(jobId) + "\"}");
        } else {
          emitLine("{\"type\":\"import_error\",\"reqId\":\"" + pp::jsonEscape(reqId) +
                   "\",\"jobId\":\"" + pp::jsonEscape(jobId) +
                   "\",\"error\":\"" + pp::jsonEscape(outcome.errorMessage) + "\"}");
        }
      } else if (cmd == "commit_model") {
        const std::string modelId = pp::extractJsonString(line, "modelId").value_or("");
        bool committed = false;
        std::vector<std::string> dirsToCleanup;
        {
          std::lock_guard<std::mutex> lock(state.jobsMutex);
          std::vector<std::string> retained;
          const auto encoded = pp::extractJsonString(line, "kitModelIds").value_or("");
          std::istringstream fields(encoded);
          for (std::string partId; std::getline(fields, partId, ',');) retained.push_back(partId);
          if (state.models.find(modelId) != state.models.end() &&
              std::all_of(retained.begin(), retained.end(), [&](const std::string& id) {
                return state.models.find(id) != state.models.end() && id != modelId && id != state.activeModelId;
              })) {
            for (auto it = state.models.begin(); it != state.models.end();) {
              if (it->first != modelId && std::find(retained.begin(), retained.end(), it->first) == retained.end()) {
                dirsToCleanup.push_back(it->second.jobDir);
                it = state.models.erase(it);
              } else {
                ++it;
              }
            }
            state.activeModelId = modelId;
            state.pickCache.clear();
            state.topology.clear();
            state.lighting.clear();
            state.dxr.clear();
            committed = true;
          }
        }
        for (const auto& d : dirsToCleanup) {
          pp::cleanupJobDir(d);
        }
        emitLine("{\"type\":\"commit_ack\",\"reqId\":\"" + pp::jsonEscape(reqId) +
                 "\",\"committed\":" + (committed ? "true" : "false") + "}");
      } else if (cmd == "discard_model") {
        const std::string modelId = pp::extractJsonString(line, "modelId").value_or("");
        bool discarded = false;
        std::string dirToCleanup;
        {
          std::lock_guard<std::mutex> lock(state.jobsMutex);
          if (modelId != state.activeModelId) {
            auto it = state.models.find(modelId);
            if (it != state.models.end()) {
              dirToCleanup = it->second.jobDir;
              state.models.erase(it);
              discarded = true;
            }
          }
        }
        if (!dirToCleanup.empty()) {
          pp::cleanupJobDir(dirToCleanup);
        }
        emitLine("{\"type\":\"discard_ack\",\"reqId\":\"" + pp::jsonEscape(reqId) +
                 "\",\"discarded\":" + (discarded ? "true" : "false") + "}");
      } else if (cmd == "ridge_band") {
        const std::string jobId = pp::extractJsonString(line, "jobId").value_or("");
        const std::string modelId = pp::extractJsonString(line, "modelId").value_or("");
        const std::string prefix = "\",\"reqId\":\"" + pp::jsonEscape(reqId) + "\"";
        try {
          const auto params = pp::extractJsonNumberArray(line, "ridgeParams");
          const auto regionPath = pp::extractJsonString(line, "regionPath");
          const auto model = state.models.find(modelId);
          if (!job.cancelFlag || !params || params->size() != 2 || !regionPath ||
              model == state.models.end() ||
              !((*params)[0] >= 1 && (*params)[0] <= 180) || !((*params)[1] > 0 && (*params)[1] <= 100)) {
            throw std::runtime_error("The ridge model or options are unavailable.");
          }
          const bool ready = state.topology.matches(model->second) ||
            state.topology.build(model->second, *job.cancelFlag);
          const auto filePath = ready ? state.topology.writeRidgeBand(model->second, jobId,
              (*params)[0], (*params)[1], *regionPath, *job.cancelFlag) : "";
          if (filePath.empty()) {
            emitLine("{\"type\":\"fill_canceled" + prefix + "}");
          } else {
            emitLine("{\"type\":\"fill_complete" + prefix + ",\"filePath\":\"" + pp::jsonEscape(filePath) + "\"}");
          }
        } catch (const std::exception& error) {
          emitLine("{\"type\":\"fill_error" + prefix + ",\"error\":\"" + pp::jsonEscape(error.what()) + "\"}");
        }
        {
          std::lock_guard<std::mutex> lock(state.jobsMutex);
          state.pendingOrRunningJobs.erase(jobId);
        }
      } else if (cmd == "connected_fill") {
        const std::string jobId = pp::extractJsonString(line, "jobId").value_or("");
        const std::string modelId = pp::extractJsonString(line, "modelId").value_or("");
        const std::string prefix = "\",\"reqId\":\"" + pp::jsonEscape(reqId) + "\"";
        try {
          auto params = pp::extractJsonNumberArray(line, "fillParams");
          auto blocked = pp::extractJsonUIntArray(line, "blockedFaces");
          auto model = state.models.find(modelId);
          const bool coplanar = pp::extractJsonBool(line, "coplanar").value_or(false);
          if (!job.cancelFlag || !params || params->size() != 2 || !blocked || model == state.models.end()) {
            throw std::runtime_error("The fill model or options are unavailable.");
          }
          const double seed = (*params)[0];
          const double angle = (*params)[1];
          if (!(seed >= 0 && seed < model->second.triangleCount && seed == std::floor(seed)) ||
              !(angle >= 0 && angle <= 180)) {
            throw std::runtime_error("Invalid fill face or crease angle.");
          }

          const bool ready = state.topology.matches(model->second) ||
            state.topology.build(model->second, *job.cancelFlag);
          const std::string filePath = ready
            ? state.topology.writeConnectedFill(model->second, jobId, static_cast<uint32_t>(seed),
                                                angle, *blocked, coplanar, *job.cancelFlag)
            : "";
          if (filePath.empty()) {
            emitLine("{\"type\":\"fill_canceled" + prefix + "}");
          } else {
            emitLine("{\"type\":\"fill_complete" + prefix + ",\"filePath\":\"" + pp::jsonEscape(filePath) + "\"}");
          }
        } catch (const std::exception& error) {
          emitLine("{\"type\":\"fill_error" + prefix + ",\"error\":\"" + pp::jsonEscape(error.what()) + "\"}");
        }
        {
          std::lock_guard<std::mutex> lock(state.jobsMutex);
          state.pendingOrRunningJobs.erase(jobId);
        }
      } else if (cmd == "light_exposure") {
        const std::string jobId = pp::extractJsonString(line, "jobId").value_or("");
        const std::string modelId = pp::extractJsonString(line, "modelId").value_or("");
        const std::string prefix = "\",\"reqId\":\"" + pp::jsonEscape(reqId) + "\"";
        try {
          const auto direction = pp::extractJsonNumberArray(line, "direction");
          auto model = state.models.find(modelId);
          if (!job.cancelFlag || !direction || direction->size() != 3 ||
              model == state.models.end() || modelId != state.activeModelId) {
            throw std::runtime_error("The lighting model or direction is unavailable.");
          }
          const std::array<float, 3> vector{
              static_cast<float>((*direction)[0]),
              static_cast<float>((*direction)[1]),
              static_cast<float>((*direction)[2])};
          std::vector<pp::LightingPart> parts;
          const auto encoded = pp::extractJsonString(line, "exposureModels");
          if (encoded) {
            const auto poses = pp::extractJsonNumberArray(line, "exposurePoses");
            std::istringstream fields(*encoded);
            std::vector<std::pair<uint32_t, uint32_t>> ranges;
            std::unordered_set<std::string> seen;
            for (std::string id; std::getline(fields, id, ',');) {
              const size_t start = parts.size() * 8;
              const auto part = state.models.find(id);
              if (!poses || start + 8 > poses->size() || part == state.models.end() || !seen.insert(id).second) {
                throw std::runtime_error("An assembled lighting part is unavailable.");
              }
              const auto offset = (*poses)[start];
              if (offset < 0 || offset != std::floor(offset) || offset + part->second.triangleCount > 100000000) {
                throw std::runtime_error("Invalid assembled face address.");
              }
              pp::LightingPart desc{&part->second, static_cast<uint32_t>(offset)};
              for (size_t i = 0; i < desc.pose.size(); ++i) {
                desc.pose[i] = static_cast<float>((*poses)[start + i + 1]);
                if (!std::isfinite(desc.pose[i])) throw std::runtime_error("Invalid part pose.");
              }
              parts.push_back(desc);
              ranges.emplace_back(desc.faceOffset, desc.faceOffset + part->second.triangleCount);
            }
            if (parts.empty() || parts[0].model != &model->second || parts[0].faceOffset != 0 ||
                !poses || parts.size() * 8 != poses->size()) {
              throw std::runtime_error("Invalid assembled lighting layout.");
            }
            std::sort(ranges.begin(), ranges.end());
            for (size_t i = 1; i < ranges.size(); ++i) {
              if (ranges[i - 1].second > ranges[i].first) throw std::runtime_error("Overlapping part face addresses.");
            }
          }
          const auto option = pp::extractJsonString(line, "exposureBackend").value_or("auto");
          const auto start = std::chrono::steady_clock::now();
          std::string backend = "cpu", fallback, filePath;
          pp::DxrTimings timing;
          // Local comparisons showed a clear end-to-end benefit at reference-model scale.
          constexpr uint32_t referenceScale = 8000000;
          const bool wantsDxr = option == "auto" ? model->second.triangleCount >= referenceScale : option != "cpu";
          if (wantsDxr && parts.empty()) {
            try {
              std::vector<float> scores;
              if (state.dxr.compute(model->second, vector, *job.cancelFlag, option, scores, timing)) {
                filePath = pp::writeExposureFile(model->second, jobId, scores, *job.cancelFlag);
                backend = "dxr";
              }
            } catch (const std::exception& failure) {
              state.dxr.clear();
              fallback = failure.what();
            }
          }
          if (backend == "cpu" && !job.cancelFlag->load(std::memory_order_relaxed)) {
            filePath = state.lighting.writeExposure(model->second, jobId, vector, *job.cancelFlag, parts);
          }
          const double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
          if (filePath.empty()) {
            emitLine("{\"type\":\"light_canceled" + prefix + "}");
          } else {
            emitLine("{\"type\":\"light_complete" + prefix + ",\"filePath\":\"" + pp::jsonEscape(filePath) +
                     "\",\"backend\":\"" + backend + "\",\"fallback\":\"" + pp::jsonEscape(fallback) +
                     "\",\"nativeMs\":" + std::to_string(elapsed) + ",\"setupMs\":" + std::to_string(timing.setupMs) +
                     ",\"dispatchMs\":" + std::to_string(timing.dispatchMs) + ",\"readbackMs\":" + std::to_string(timing.readbackMs) +
                     ",\"peakDedicatedBytes\":" + std::to_string(timing.peakDedicatedBytes) + ",\"budget\":" + std::to_string(timing.budget) + "}");
          }
        } catch (const std::exception& error) {
          emitLine("{\"type\":\"light_error" + prefix + ",\"error\":\"" + pp::jsonEscape(error.what()) + "\"}");
        }
        {
          std::lock_guard<std::mutex> lock(state.jobsMutex);
          state.pendingOrRunningJobs.erase(jobId);
        }
      } else if (cmd == "pick") {
        const std::string modelId = pp::extractJsonString(line, "modelId").value_or("");
        auto originOpt = pp::extractJsonNumberArray(line, "origin");
        auto dirOpt = pp::extractJsonNumberArray(line, "direction");
        auto batchIndicesOpt = pp::extractJsonUIntArray(line, "batchIndices");

        pp::ModelRecord modelCopy;
        bool found = false;
        {
          std::lock_guard<std::mutex> lock(state.jobsMutex);
          auto it = state.models.find(modelId);
          if (it != state.models.end()) {
            modelCopy = it->second;
            found = true;
          }
        }

        if (!found || !originOpt || originOpt->size() != 3 || !dirOpt || dirOpt->size() != 3) {
          emitLine("{\"type\":\"pick_result\",\"reqId\":\"" + pp::jsonEscape(reqId) +
                   "\",\"hit\":false,\"partId\":null,\"originalFaceId\":null,\"distance\":null,\"point\":null,\"normal\":null}");
          continue;
        }

        std::array<float, 3> orig{
            static_cast<float>((*originOpt)[0]),
            static_cast<float>((*originOpt)[1]),
            static_cast<float>((*originOpt)[2]),
        };
        std::array<float, 3> dir{
            static_cast<float>((*dirOpt)[0]),
            static_cast<float>((*dirOpt)[1]),
            static_cast<float>((*dirOpt)[2]),
        };

        auto res = pp::pickModelFace(
            modelCopy,
            orig,
            dir,
            state.pickCache,
            batchIndicesOpt ? &(*batchIndicesOpt) : nullptr);
        if (!res.hit) {
          emitLine("{\"type\":\"pick_result\",\"reqId\":\"" + pp::jsonEscape(reqId) +
                   "\",\"hit\":false,\"partId\":null,\"originalFaceId\":null,\"distance\":null,\"point\":null,\"normal\":null}");
        } else {
          emitLine("{\"type\":\"pick_result\",\"reqId\":\"" + pp::jsonEscape(reqId) +
                   "\",\"hit\":true,\"partId\":\"" + pp::jsonEscape(res.partId) +
                   "\",\"originalFaceId\":" + std::to_string(res.originalFaceId) +
                   ",\"batchIndex\":" + std::to_string(res.batchIndex) +
                   ",\"triangleIndex\":" + std::to_string(res.triangleIndex) +
                   ",\"distance\":" + std::to_string(res.distance) +
                   ",\"point\":" + formatVec3(res.point.data()) +
                   ",\"normal\":" + formatVec3(res.normal.data()) + "}");
        }
      } else if (cmd == "get_active_model") {
        std::lock_guard<std::mutex> lock(state.jobsMutex);
        auto it = state.models.find(state.activeModelId);
        if (it == state.models.end()) {
          emitLine("{\"type\":\"active_model\",\"reqId\":\"" + pp::jsonEscape(reqId) + "\",\"model\":null}");
        } else {
          emitLine("{\"type\":\"active_model\",\"reqId\":\"" + pp::jsonEscape(reqId) + "\",\"model\":" + formatModelJson(it->second) + "}");
        }
      }
    }
  });

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    auto cmdOpt = pp::extractJsonString(line, "cmd");
    if (!cmdOpt) continue;
    if (*cmdOpt == "shutdown") {
      break;
    }
    if (*cmdOpt == "cancel") {
      const std::string jobId = pp::extractJsonString(line, "jobId").value_or("");
      const std::string reqId = pp::extractJsonString(line, "reqId").value_or("");
      bool canceled = false;
      {
        std::lock_guard<std::mutex> lock(state.jobsMutex);
        auto it = state.pendingOrRunningJobs.find(jobId);
        if (it != state.pendingOrRunningJobs.end()) {
          it->second->store(true, std::memory_order_relaxed);
          canceled = true;
        }
      }
      emitLine("{\"type\":\"cancel_ack\",\"reqId\":\"" + pp::jsonEscape(reqId) +
               "\",\"canceled\":" + (canceled ? "true" : "false") + "}");
      continue;
    }

    std::shared_ptr<std::atomic<bool>> flag;
    if (*cmdOpt == "import" || *cmdOpt == "connected_fill" || *cmdOpt == "ridge_band" || *cmdOpt == "light_exposure") {
      const std::string jobId = pp::extractJsonString(line, "jobId").value_or("");
      if (isValidJobId(jobId)) {
        std::lock_guard<std::mutex> lock(state.jobsMutex);
        flag = std::make_shared<std::atomic<bool>>(false);
        state.pendingOrRunningJobs[jobId] = flag;
      }
    }

    {
      std::lock_guard<std::mutex> lock(queueMutex);
      jobQueue.push(QueuedJob{std::move(line), std::move(flag)});
    }
    queueCv.notify_one();
  }

  {
    std::lock_guard<std::mutex> lock(state.jobsMutex);
    for (const auto& [id, flag] : state.pendingOrRunningJobs) {
      flag->store(true, std::memory_order_relaxed);
    }
  }
  {
    std::lock_guard<std::mutex> lock(queueMutex);
    shuttingDown = true;
  }
  queueCv.notify_all();
  workerThread.join();

  state.pickCache.clear();
  {
    std::lock_guard<std::mutex> lock(state.jobsMutex);
    for (const auto& kv : state.models) {
      pp::cleanupJobDir(kv.second.jobDir);
    }
  }

  return 0;
}
