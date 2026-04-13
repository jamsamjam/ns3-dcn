#include "ns3/applications-module.h"
#include "ns3/core-module.h"
#include "ns3/internet-module.h"
#include "ns3/ipv4-global-routing-helper.h"
#include "ns3/network-module.h"
#include "ns3/point-to-point-module.h"
#include "ns3/traffic-control-module.h"
#include "ns3/tcp-l4-protocol.h"

#include "config/topology.h"
#include "config/csv-logger.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <tuple>
#include <unordered_map>
#include <vector>

using namespace ns3;

NS_LOG_COMPONENT_DEFINE("SimpleTopology");

static uint16_t port = 9;

struct QueueMetrics
{
    uint32_t maxQueueSize = 0;
    uint32_t packetsLost = 0;
    uint32_t packetsQueued = 0; // accumulated count of packets that entered the queue
    double totalSojournTime = 0.0; // total time packets spent in queue (ms); dequeue - enqueue; sojourn = temporary stay
    uint32_t sojournSampleCount = 0;
};

struct LinkInfo
{
    std::string linkId;
    uint32_t from;
    uint32_t to;
    std::string rate;
    std::string delay;
};

struct PacketArrivalInfo
{
    uint32_t size = 0;
    double arrivalTime = 0.0;
};

struct LinkTraceData
{
    std::unordered_map<uint64_t, PacketArrivalInfo> arrivals;
    QueueMetrics metrics;
};

static std::unordered_map<std::string, LinkTraceData> tracesByLink;
static CsvLogger* g_csvLogger = nullptr;

static std::vector<std::string>
Split(const std::string& s, char delim)
{
    std::vector<std::string> parts;
    std::stringstream ss(s);
    std::string item;

    while (std::getline(ss, item, delim))
    {
        if (!item.empty())
        {
            parts.push_back(item);
        }
    }

    return parts;
}

static std::vector<std::string>
BuildLinkRates(const std::string& linkRatesArg, size_t linkCount, const std::string& defaultRate)
{
    std::vector<std::string> linkRates(linkCount, defaultRate);

    if (linkRatesArg.empty())
    {
        return linkRates;
    }

    std::vector<std::string> parsed = Split(linkRatesArg, ',');

    for (size_t i = 0; i < parsed.size() && i < linkCount; ++i)
    {
        linkRates[i] = parsed[i];
    }

    return linkRates;
}

static void
QueueLenTrace(std::string linkId, uint32_t oldValue, uint32_t newValue)
{
    auto& trace = tracesByLink[linkId];

    trace.metrics.maxQueueSize = std::max(trace.metrics.maxQueueSize, newValue);
    if (newValue > oldValue)
    {
        trace.metrics.packetsQueued += (newValue - oldValue);
    }
}

static void
SojournTrace(std::string linkId, Time t)
{
    const double delayMs = t.GetNanoSeconds() / 1e6;

    auto& trace = tracesByLink[linkId];
    trace.metrics.totalSojournTime += delayMs;
    trace.metrics.sojournSampleCount++;
}

static void
DropTrace(std::string linkId, Ptr<const QueueDiscItem> item)
{
    auto& trace = tracesByLink[linkId];
    trace.metrics.packetsLost++;
}

static void
ArrivalTrace(std::string linkId, Ptr<const QueueDiscItem> item)
{
    Ptr<const Packet> packet = item->GetPacket();

    PacketArrivalInfo info;
    info.size = packet->GetSize();
    info.arrivalTime = Simulator::Now().GetSeconds();

    tracesByLink[linkId].arrivals[packet->GetUid()] = info;
}

static void
DequeueTrace(std::string linkId, Ptr<const QueueDiscItem> item)
{
    Ptr<const Packet> packet = item->GetPacket();
    auto& trace = tracesByLink[linkId];

    uint64_t id = packet->GetUid();
    double arrivingTime = Simulator::Now().GetSeconds();

    auto it = trace.arrivals.find(id);
    if (it == trace.arrivals.end())
    {
        return;
    }

    const uint32_t size = it->second.size;
    const double arrivalTime = it->second.arrivalTime;

    if (g_csvLogger != nullptr)
    {
        g_csvLogger->Log(linkId, CsvLogger::Row{id, size, arrivalTime, arrivingTime});
    }

    trace.arrivals.erase(it);
}

int
main(int argc, char* argv[])
{
    std::string configFilename = "config/simple-topology.json";
    std::string topologyName;
    std::string csvDir = "../backend/output";

    std::string queueSizeStr = "100p";
    std::string sendingRateStr = "5Mbps";
    std::string tcpType = "ns3::TcpNewReno";
    std::string defaultLinkRate = "10Mbps";
    std::string linkRatesArg = "";

    double simTime = 10.0; // seconds

    CommandLine cmd(__FILE__);
    cmd.AddValue("config", "Topology config file", configFilename);
    cmd.AddValue("csvDir", "Directory for csv output", csvDir);
    cmd.AddValue("queueSize", "Max queue size", queueSizeStr);
    cmd.AddValue("rate", "Application sending rate", sendingRateStr);
    cmd.AddValue("tcp", "TCP variant", tcpType);
    cmd.AddValue("defaultLinkRate", "Default rate for all links", defaultLinkRate);
    cmd.AddValue("linkRates", "Comma-separated link rates, e.g. 10Mbps,1Mbps,5Mbps", linkRatesArg);
    cmd.AddValue("time", "Simulation time in seconds", simTime);
    cmd.Parse(argc, argv);

    std::vector<LinkInfo> linkInfos;
    if (!topology::LoadTopology(configFilename, linkInfos))
    {
        std::cerr << "Failed to load topology config: " << configFilename << "\n";
        return 1;
    }

    if (linkInfos.empty())
    {
        std::cerr << "No links in topology config\n";
        return 1;
    }

    std::vector<std::string> linkRates =
    BuildLinkRates(linkRatesArg, linkInfos.size(), defaultLinkRate);

    Config::SetDefault("ns3::TcpL4Protocol::SocketType", StringValue(tcpType));
    Time::SetResolution(Time::NS);

    uint32_t maxNodeId = 0;
    for (const auto& link : linkInfos)
    {
        maxNodeId = std::max(maxNodeId, std::max(link.from, link.to));
    }

    NodeContainer nodes;
    nodes.Create(maxNodeId + 1);

    InternetStackHelper stack;
    stack.Install(nodes);

    TrafficControlHelper tch;
    tch.SetRootQueueDisc("ns3::FifoQueueDisc", "MaxSize", StringValue(queueSizeStr));

    std::vector<NetDeviceContainer> devicesByLink;
    std::vector<Ptr<QueueDisc>> qdiscsByLink;
    std::vector<Ipv4InterfaceContainer> interfacesByLink;

    Ipv4AddressHelper address;
    for (size_t i = 0; i < linkInfos.size(); ++i)
    {
        const auto& link = linkInfos[i];

        NodeContainer pair(nodes.Get(link.from), nodes.Get(link.to));

        PointToPointHelper p2p;
        p2p.SetDeviceAttribute("DataRate", StringValue(linkRates[i]));
        p2p.SetChannelAttribute("Delay", StringValue(link.delay));

        NetDeviceContainer devices = p2p.Install(pair);
        devicesByLink.push_back(devices);

        QueueDiscContainer qdiscs = tch.Install(devices);
        qdiscsByLink.push_back(qdiscs.Get(0));

        std::string subnet = "10.1." + std::to_string(i + 1) + ".0";
        address.SetBase(subnet.c_str(), "255.255.255.0");
        interfacesByLink.push_back(address.Assign(devices));
    }

    Ipv4GlobalRoutingHelper::PopulateRoutingTables();

    uint32_t sourceNodeId = linkInfos.front().from;
    uint32_t sinkNodeId = linkInfos.back().to;

    PacketSinkHelper sinkHelper(
        "ns3::TcpSocketFactory",
        InetSocketAddress(Ipv4Address::GetAny(), port));
    ApplicationContainer sinkApps = sinkHelper.Install(nodes.Get(sinkNodeId));
    sinkApps.Start(Seconds(0.0));
    sinkApps.Stop(Seconds(simTime + 1.0)); // to allow processing of last packets

    // OnOffHelper: sends at constant rate when on, idle when off
    OnOffHelper onoffHelper("ns3::TcpSocketFactory",
        InetSocketAddress(interfacesByLink.back().GetAddress(1), port));

    // Set constant sending rate and packet size
    onoffHelper.SetConstantRate(DataRate(sendingRateStr), 1024);
    onoffHelper.SetAttribute("OnTime", StringValue("ns3::ConstantRandomVariable[Constant=10.0]"));
    onoffHelper.SetAttribute("OffTime", StringValue("ns3::ConstantRandomVariable[Constant=0.0]"));

    ApplicationContainer sendApps = onoffHelper.Install(nodes.Get(sourceNodeId));
    sendApps.Start(Seconds(1.0));
    sendApps.Stop(Seconds(simTime));

    CsvLogger csvLogger(csvDir);
    g_csvLogger = &csvLogger;

    const auto connectTraces = [&](Ptr<QueueDisc> qdisc, const std::string& linkId) {
        qdisc->TraceConnectWithoutContext(
            "PacketsInQueue",
            MakeBoundCallback(&QueueLenTrace, linkId));

        qdisc->TraceConnectWithoutContext(
            "SojournTime",
            MakeBoundCallback(&SojournTrace, linkId));

        qdisc->TraceConnectWithoutContext(
            "Drop",
            MakeBoundCallback(&DropTrace, linkId));

        qdisc->TraceConnectWithoutContext(
            "Enqueue",
            MakeBoundCallback(&ArrivalTrace, linkId));

        qdisc->TraceConnectWithoutContext(
            "Dequeue",
            MakeBoundCallback(&DequeueTrace, linkId));
    };

    for (size_t i = 0; i < linkInfos.size(); ++i)
    {
        connectTraces(qdiscsByLink[i], linkInfos[i].linkId);
    }

    Simulator::Stop(Seconds(simTime + 1.0));
    Simulator::Run();

    csvLogger.CloseAll();
    g_csvLogger = nullptr;

    Simulator::Destroy();
    return 0;
}