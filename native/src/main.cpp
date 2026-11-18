#include "protocol.hpp"
#include "stl_importer.hpp"

#include <atomic>
#include <cctype>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <unordered_map>

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
          if (state.models.find(modelId) != state.models.end()) {
            for (auto it = state.models.begin(); it != state.models.end();) {
              if (it->first != modelId) {
                dirsToCleanup.push_back(it->second.jobDir);
                it = state.models.erase(it);
              } else {
                ++it;
              }
            }
            state.activeModelId = modelId;
            state.pickCache.clear();
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
    if (*cmdOpt == "import") {
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
