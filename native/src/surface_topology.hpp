#pragma once

#include "stl_importer.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

namespace pp {

class SurfaceTopology {
 public:
  bool matches(const ModelRecord& model) const;
  bool build(const ModelRecord& model, const std::atomic<bool>& canceled);
  std::string writeConnectedFill(
      const ModelRecord& model,
      const std::string& jobId,
      uint32_t seed,
      double maxCreaseDegrees,
      const std::vector<uint32_t>& blockedFaces,
      bool coplanar,
      const std::atomic<bool>& canceled) const;
  std::string writeRidgeBand(
      const ModelRecord& model,
      const std::string& jobId,
      double crease,
      double widthPercent,
      const std::string& regionPath,
      const std::atomic<bool>& canceled) const;
  void clear();

 private:
  struct Face {
    uint32_t batchIndex;
    uint32_t triangleIndex;
    uint32_t neighbors[3];
    std::array<float, 3> normal;
    std::array<float, 3> center;
    std::array<float, 3> edgeDistance;
    std::array<uint8_t, 3> convexAngle;
  };

  std::string writeHits(const ModelRecord& model, std::string name,
      const std::vector<uint32_t>& hits, const std::atomic<bool>& canceled) const;
  std::string modelId_;
  std::vector<Face> faces_;
};

}  // namespace pp
