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
