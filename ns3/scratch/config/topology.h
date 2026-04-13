#pragma once

#include <fstream>
#include <string>
#include <vector>

#include <json/json.h>

namespace topology
{
template <typename LinkInfoT>
bool LoadTopology(const std::string& configFilename,
                        std::vector<LinkInfoT>& linkInfos)
{
    std::ifstream configIn(configFilename);
    if (!configIn.is_open())
    {
        return false;
    }

    Json::CharReaderBuilder builder;
    Json::Value root;
    std::string errors;
    if (!Json::parseFromStream(builder, configIn, &root, &errors))
    {
        return false;
    }

    linkInfos.clear();
    for (const auto& link : root["links"])
    {
        linkInfos.push_back({
            link.get("linkId", "").asString(),
            link.get("from", 0).asUInt(),
            link.get("to", 0).asUInt(),
            link.get("delay", "").asString()
        });
    }

    return !linkInfos.empty();
}
}