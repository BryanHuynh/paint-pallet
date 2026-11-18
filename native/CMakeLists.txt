cmake_minimum_required(VERSION 3.20)
project(paint_pallet_worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(meshoptimizer STATIC
  vendor/meshoptimizer/allocator.cpp
  vendor/meshoptimizer/simplifier.cpp
)
target_include_directories(meshoptimizer PUBLIC vendor/meshoptimizer)

add_executable(paint_pallet_worker
  src/main.cpp
  src/stl_importer.cpp
  src/surface_topology.cpp
  src/surface_lighting.cpp
)

target_link_libraries(paint_pallet_worker PRIVATE meshoptimizer)

if(WIN32)
  find_program(PAINT_PALLET_DXC NAMES dxc HINTS "$ENV{WindowsSdkVerBinPath}/x64" REQUIRED)
  set(EXPOSURE_SHADER "${CMAKE_CURRENT_BINARY_DIR}/exposure_shader.h")
  add_custom_command(OUTPUT "${EXPOSURE_SHADER}"
    COMMAND "${PAINT_PALLET_DXC}" -T cs_6_5 -E main -O3
      -Fh "${EXPOSURE_SHADER}" -Vn g_exposureShader "${CMAKE_CURRENT_SOURCE_DIR}/src/exposure.hlsl"
    DEPENDS src/exposure.hlsl
    VERBATIM
  )
  target_sources(paint_pallet_worker PRIVATE src/dxr_lighting.cpp "${EXPOSURE_SHADER}")
  target_include_directories(paint_pallet_worker PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
  target_link_libraries(paint_pallet_worker PRIVATE d3d12 dxgi)
  set(PAINT_PALLET_EMBREE_ROOT "" CACHE PATH "Pinned Embree Windows SDK")
  target_include_directories(paint_pallet_worker PRIVATE "${PAINT_PALLET_EMBREE_ROOT}/include")
  target_link_libraries(paint_pallet_worker PRIVATE "${PAINT_PALLET_EMBREE_ROOT}/lib/embree4.lib")
  foreach(dll embree4.dll tbb12.dll tbbmalloc.dll)
    configure_file("${PAINT_PALLET_EMBREE_ROOT}/bin/${dll}" "${CMAKE_BINARY_DIR}/${dll}" COPYONLY)
  endforeach()
  foreach(license LICENSE.txt third-party-programs.txt third-party-programs-TBB.txt)
    configure_file("${PAINT_PALLET_EMBREE_ROOT}/share/doc/Embree_superbuild/${license}"
      "${CMAKE_BINARY_DIR}/embree-notices/${license}" COPYONLY)
  endforeach()
  target_compile_definitions(paint_pallet_worker PRIVATE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
    _CRT_SECURE_NO_WARNINGS
  )
endif()

set_target_properties(paint_pallet_worker PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)
