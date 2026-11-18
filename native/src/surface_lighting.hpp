#pragma once

#include "stl_importer.hpp"
#include <embree4/rtcore.h>

#include <array>
#include <atomic>
#include <string>
#include <vector>

namespace pp {

class SurfaceLighting {
 public:
  ~SurfaceLighting();

  std::string writeExposure(
      const ModelRecord& model,
      const std::string& jobId,
      const std::array<float, 3>& direction,
      const std::atomic<bool>& canceled);

  void clear();

 private:
  bool prepare(const ModelRecord& model, const std::atomic<bool>& canceled);
  bool trace(const ModelRecord& model, const std::array<float, 3>& direction, const std::atomic<bool>& canceled);

  struct Batch {
    const float* vertices;
    std::vector<uint32_t> faceIds;
  };

  RTCDevice device_ = nullptr;
  RTCScene scene_ = nullptr;
  std::string modelId_;
  std::vector<Batch> batches_;
  std::array<float, 3> scoredDirection_{};
  std::vector<float> exposure_;
};

}  // namespace pp
