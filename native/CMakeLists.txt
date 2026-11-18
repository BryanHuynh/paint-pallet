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
)

target_link_libraries(paint_pallet_worker PRIVATE meshoptimizer)

if(WIN32)
  target_compile_definitions(paint_pallet_worker PRIVATE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
    _CRT_SECURE_NO_WARNINGS
  )
endif()

set_target_properties(paint_pallet_worker PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)
