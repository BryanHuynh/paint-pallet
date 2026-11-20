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

class LightingTransform {
 public:
  explicit LightingTransform(const std::array<float, 7>& pose);
  float transformCoordinate(const float* vertex, size_t axis) const;

 private:
  float basis_[3][3];
  float translation_[3];
};

std::string lightingSceneKey(const ModelRecord& model, const std::vector<LightingPart>& layout);

class SurfaceLighting {
 public:
  ~SurfaceLighting();

  std::string writeExposure(
      const ModelRecord& model,
      const std::string& jobId,
      const std::array<float, 3>& direction,
      const std::atomic<bool>& canceled,
      const std::vector<LightingPart>& parts = {},
      bool castShadowsBetweenParts = true);

  void clear();

 private:
  bool prepare(const std::vector<LightingPart>& parts, const std::string& key, const std::atomic<bool>& canceled);
  bool trace(const std::array<float, 3>& direction, const std::atomic<bool>& canceled, bool selfOnly);

  struct Batch {
    const float* vertices;
    std::vector<uint32_t> faceIds;
    uint32_t faceOffset;
    const ModelRecord* model;
  };

  RTCDevice device_ = nullptr;
  RTCScene scene_ = nullptr;
  std::string sceneKey_;
  size_t scoreCount_ = 0;
  float extent_ = 0;
  std::vector<Batch> batches_;
  std::array<float, 3> scoredDirection_{};
  bool scoredSelfOnly_ = false;
  std::vector<float> exposure_;
};

}  // namespace pp
