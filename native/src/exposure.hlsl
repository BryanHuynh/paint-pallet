RaytracingAccelerationStructure surface : register(t0);
StructuredBuffer<float3> positions : register(t1);
RWStructuredBuffer<float> exposure : register(u0);

cbuffer RaySettings : register(b0) {
  float3 direction;
  float bias;
  uint firstFace;
  uint faceCount;
};

[numthreads(128, 1, 1)]
void main(uint3 thread : SV_DispatchThreadID) {
  const uint id = firstFace + thread.x;
  if (thread.x >= faceCount) return;
  const float3 a = positions[id * 3];
  const float3 b = positions[id * 3 + 1];
  const float3 c = positions[id * 3 + 2];
  const float3 normal = cross(b - a, c - a);
  const float light = dot(normal, direction);
  const float area = length(normal);
  if (light <= 0 || area <= 0) {
    exposure[id] = 0;
    return;
  }
  RayDesc ray;
  ray.Origin = float3((double3(a) + double3(b) + double3(c)) / 3.0L);
  ray.Direction = direction;
  ray.TMin = bias;
  ray.TMax = 3.402823e38;
  RayQuery<RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH | RAY_FLAG_FORCE_OPAQUE> query;
  query.TraceRayInline(surface, RAY_FLAG_NONE, 0xff, ray);
  while (query.Proceed()) {}
  exposure[id] = query.CommittedStatus() == COMMITTED_NOTHING ? min(1.0, light / area) : 0;
}
