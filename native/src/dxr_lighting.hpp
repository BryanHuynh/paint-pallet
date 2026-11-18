#pragma once

#include "stl_importer.hpp"

#include <array>
#include <atomic>
#include <memory>
#include <string>
#include <vector>

namespace pp {

struct DxrTimings {
  double setupMs = 0;
  double dispatchMs = 0;
  double readbackMs = 0;
  uint64_t budget = 0;
  uint64_t peakDedicatedBytes = 0;
};

class DxrLighting {
 public:
  DxrLighting();
  ~DxrLighting();

  bool compute(const ModelRecord& model, const std::array<float, 3>& direction,
      const std::atomic<bool>& canceled, const std::string& option,
      std::vector<float>& scores, DxrTimings& timing);
  void clear();

 private:
  class Scene;
  std::unique_ptr<Scene> scene_;
};

}  // namespace pp
