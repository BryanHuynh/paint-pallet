#pragma once

#include "stl_importer.hpp"
#include <embree4/rtcore.h>

#include <array>
#include <atomic>
#include <string>
#include <vector>

namespace pp {

std::string writeExposureFile(const ModelRecord& model, const std::string& jobId,
    const std::vector<float>& scores, const std::atomic<bool>& canceled);

struct LightingPart {
  const ModelRecord* model;
  uint32_t faceOffset = 0;
  std::array<float, 7> pose = {0, 0, 0, 0, 0, 0, 1};
};

class SurfaceLighting {
 public:
  ~SurfaceLighting();

  std::string writeExposure(
      const ModelRecord& model,
      const std::string& jobId,
      const std::array<float, 3>& direction,
      const std::atomic<bool>& canceled,
      const std::vector<LightingPart>& parts = {});

  void clear();

 private:
  bool prepare(const std::vector<LightingPart>& parts, const std::string& key, const std::atomic<bool>& canceled);
  bool trace(const std::array<float, 3>& direction, const std::atomic<bool>& canceled);

  struct Batch {
    const float* vertices;
    std::vector<uint32_t> faceIds;
    uint32_t faceOffset;
  };

  RTCDevice device_ = nullptr;
  RTCScene scene_ = nullptr;
  std::string sceneKey_;
  size_t scoreCount_ = 0;
  float extent_ = 0;
  std::vector<Batch> batches_;
  std::array<float, 3> scoredDirection_{};
  std::vector<float> exposure_;
};

}  // namespace pp
