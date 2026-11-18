#pragma once

#include <cctype>
#include <cstdint>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace pp {

inline std::string jsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  return out;
}

inline std::optional<std::string> extractJsonString(const std::string& json, const std::string& key) {
  std::string pattern = "\"" + key + "\"";
  size_t pos = json.find(pattern);
  while (pos != std::string::npos) {
    size_t colon = pos + pattern.size();
    while (colon < json.size() && std::isspace(static_cast<unsigned char>(json[colon]))) ++colon;
    if (colon < json.size() && json[colon] == ':') {
      size_t valStart = colon + 1;
      while (valStart < json.size() && std::isspace(static_cast<unsigned char>(json[valStart]))) ++valStart;
      if (valStart < json.size() && json[valStart] == '"') {
        std::string result;
        size_t i = valStart + 1;
        while (i < json.size()) {
          char c = json[i];
          if (c == '\\' && i + 1 < json.size()) {
            char next = json[i + 1];
            switch (next) {
              case '"': result.push_back('"'); break;
              case '\\': result.push_back('\\'); break;
              case '/': result.push_back('/'); break;
              case 'b': result.push_back('\b'); break;
              case 'f': result.push_back('\f'); break;
              case 'n': result.push_back('\n'); break;
              case 'r': result.push_back('\r'); break;
              case 't': result.push_back('\t'); break;
              default: result.push_back(next); break;
            }
            i += 2;
            continue;
          }
          if (c == '"') {
            return result;
          }
          result.push_back(c);
          ++i;
        }
      }
      return std::nullopt;
    }
    pos = json.find(pattern, pos + 1);
  }
  return std::nullopt;
}

inline std::optional<std::vector<double>> extractJsonNumberArray(const std::string& json, const std::string& key) {
  std::string pattern = "\"" + key + "\"";
  size_t pos = json.find(pattern);
  if (pos == std::string::npos) return std::nullopt;
  size_t colon = json.find(':', pos + pattern.size());
  if (colon == std::string::npos) return std::nullopt;
  size_t lb = json.find('[', colon);
  if (lb == std::string::npos) return std::nullopt;
  size_t rb = json.find(']', lb);
  if (rb == std::string::npos) return std::nullopt;

  std::vector<double> vals;
  std::string inside = json.substr(lb + 1, rb - lb - 1);
  std::stringstream ss(inside);
  std::string item;
  while (std::getline(ss, item, ',')) {
    try {
      vals.push_back(std::stod(item));
    } catch (...) {
      return std::nullopt;
    }
  }
  return vals;
}

inline std::optional<bool> extractJsonBool(const std::string& json, const std::string& key) {
  std::string pattern = "\"" + key + "\"";
  size_t pos = json.find(pattern);
  if (pos == std::string::npos) return std::nullopt;
  size_t colon = json.find(':', pos + pattern.size());
  if (colon == std::string::npos) return std::nullopt;
  size_t valStart = colon + 1;
  while (valStart < json.size() && std::isspace(static_cast<unsigned char>(json[valStart]))) ++valStart;
  if (json.compare(valStart, 4, "true") == 0) return true;
  if (json.compare(valStart, 5, "false") == 0) return false;
  return std::nullopt;
}

inline std::optional<std::vector<uint32_t>> extractJsonUIntArray(const std::string& json, const std::string& key) {
  auto nums = extractJsonNumberArray(json, key);
  if (!nums) return std::nullopt;
  std::vector<uint32_t> out;
  out.reserve(nums->size());
  for (double d : *nums) {
    if (d < 0.0) continue;
    out.push_back(static_cast<uint32_t>(d));
  }
  return out;
}

}  // namespace pp
