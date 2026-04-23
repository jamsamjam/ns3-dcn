#pragma once

#include <string>
#include <cstdint>
#include <unordered_map>
#include <fstream>
#include <iostream>
#include <tuple>
#include <utility>

class CsvLogger {
public:
    using Key = std::string; // "src-dst"
    using Row = std::tuple<uint64_t, uint32_t, double, double>; // id, size, enqueue_time, dequeue_time

    CsvLogger(const std::string& dir) : directory(dir) {}
    ~CsvLogger() { CloseAll(); }

    void Log(const Key& key, const Row& row) {
        auto [file, isNew] = GetFile(key);
        if (isNew) {
            file << "id,size,enqueue_time,dequeue_time\n";
        }
        file << std::get<0>(row) << ','
             << std::get<1>(row) << ','
             << std::get<2>(row) << ','
             << std::get<3>(row) << '\n';
    }

    void CloseAll() {
        for (auto& kv : files) kv.second.close();
        files.clear();
    }

private:
    std::string directory;
    std::unordered_map<Key, std::ofstream> files;

    std::pair<std::ofstream&, bool> GetFile(const Key& key) {
        auto it = files.find(key);
        if (it == files.end()) {
            // there is no file with thie key, create it
            std::string filename = directory + "/packets_" + key + ".csv";
            auto [inserted_it, _] = files.emplace(
                // files[key] = std::ofstream(filename);
                std::piecewise_construct,
                std::forward_as_tuple(key),
                std::forward_as_tuple(filename)  // ofstream(filename)
            );
            return {inserted_it->second, true};
        }
        return {it->second, false};
    }
};
