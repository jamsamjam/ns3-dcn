#include "ns3/applications-module.h"
#include "ns3/core-module.h"
#include "ns3/internet-module.h"
#include "ns3/ipv4-global-routing-helper.h"
#include "ns3/network-module.h"
#include "ns3/point-to-point-module.h"
#include "ns3/traffic-control-module.h"
#include "ns3/tcp-l4-protocol.h"

#include "CSVLogger.h"

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <numeric>
#include <string>
#include <tuple>
#include <unordered_map>
#include <vector>

using namespace ns3;

NS_LOG_COMPONENT_DEFINE("FatTreeTopology");

static uint16_t basePort = 9000;

struct QueueMetrics
{
    uint32_t maxQueueSize = 0;
    uint32_t packetsLost = 0;
    uint32_t packetsQueued = 0; // accumulated count of packets that entered the queue
    double totalSojournTime = 0.0; // total time packets spent in queue = dequeue - enqueue
    uint32_t sojournSampleCount = 0;
};

struct PacketArrivalInfo
{
    uint32_t size = 0;
    double enqueueTime = 0.0;
    bool logged = false;
};

struct LinkTraceData
{
    std::unordered_map<uint64_t, PacketArrivalInfo> arrivals;
    QueueMetrics metrics;
};

static std::unordered_map<std::string, LinkTraceData> tracesByLink;
static CsvLogger* g_csvLogger = nullptr;

static void
QueueLenTrace(std::string linkId, uint32_t oldValue, uint32_t newValue)
{
    auto& trace = tracesByLink[linkId];
    trace.metrics.maxQueueSize = std::max(trace.metrics.maxQueueSize, newValue);
    if (newValue > oldValue)
        trace.metrics.packetsQueued += (newValue - oldValue);
}

static void
DropTrace(std::string linkId, Ptr<const QueueDiscItem> item)
{
    tracesByLink[linkId].metrics.packetsLost++;
}

static void
ArrivalTrace(std::string linkId, Ptr<const QueueDiscItem> item)
{
    Ptr<const Packet> packet = item->GetPacket();
    PacketArrivalInfo info;
    info.size = packet->GetSize();
    info.enqueueTime = Simulator::Now().GetSeconds();

    // try_emplace: only insert if uid not already present
    tracesByLink[linkId].arrivals.try_emplace(packet->GetUid(), info);
}

static void
DequeueTrace(std::string linkId, Ptr<const QueueDiscItem> item)
{
    Ptr<const Packet> packet = item->GetPacket();
    auto& trace = tracesByLink[linkId];
    uint64_t id = packet->GetUid();
    double dequeueTime = Simulator::Now().GetSeconds();

    auto it = trace.arrivals.find(id);
    if (it == trace.arrivals.end() || it->second.logged)
        return;

    it->second.logged = true;

    double sojournMs = (dequeueTime - it->second.enqueueTime) * 1000.0;
    trace.metrics.totalSojournTime += sojournMs;
    trace.metrics.sojournSampleCount++;
    
    if (g_csvLogger != nullptr)
        g_csvLogger->Log(linkId, CsvLogger::Row{id, it->second.size, it->second.enqueueTime, dequeueTime});
}

struct FatTreeLink
{
    uint32_t from;
    uint32_t to;
    std::string id;
};

struct FatTreeTopo
{
    uint32_t k;
    uint32_t half;
    uint32_t numHosts;
    uint32_t numEdge;
    uint32_t numAgg;
    uint32_t numCore;
    uint32_t total;

    explicit FatTreeTopo(uint32_t k) : k(k), half(k / 2)
    {
        numHosts = (k * k * k) / 4;
        numEdge = (k * k) / 2;
        numAgg = (k * k) / 2;
        numCore = half * half;
        total = numHosts + numEdge + numAgg + numCore;
    }

    uint32_t hostId(uint32_t pod, uint32_t edge, uint32_t pos) const
    {
        return pod * half * half + edge * half + pos;
    }

    uint32_t edgeId(uint32_t pod, uint32_t idx) const
    {
        return numHosts + pod * half + idx;
    }

    uint32_t aggId(uint32_t pod, uint32_t idx) const
    {
        return numHosts + numEdge + pod * half + idx;
    }

    // core group = agg index (0..half-1); idx = 0..half-1 within group
    uint32_t coreId(uint32_t group, uint32_t idx) const
    {
        return numHosts + numEdge + numAgg + group * half + idx;
    }

    std::vector<FatTreeLink> buildLinks() const
    {
        std::vector<FatTreeLink> links;

        auto edge = [&](uint32_t a, uint32_t b) {
            links.push_back({a, b, std::to_string(a) + "-" + std::to_string(b)});
        };

        for (uint32_t p = 0; p < k; p++)
            for (uint32_t e = 0; e < half; e++)
                for (uint32_t h = 0; h < half; h++)
                    edge(hostId(p, e, h), edgeId(p, e));

        for (uint32_t p = 0; p < k; p++)
            for (uint32_t e = 0; e < half; e++)
                for (uint32_t a = 0; a < half; a++)
                    edge(edgeId(p, e), aggId(p, a));

        for (uint32_t p = 0; p < k; p++)
            for (uint32_t a = 0; a < half; a++)
                for (uint32_t j = 0; j < half; j++)
                    edge(aggId(p, a), coreId(a, j));

        return links;
    }
};

int
main(int argc, char* argv[])
{
    uint32_t k = 4;
    std::string csvBase = "../backend/output";
    std::string queueSizeStr = "100p";
    std::string sendingRateStr = "5Mbps";
    std::string tcpType = "ns3::TcpNewReno";
    const std::string linkRate = "10Mbps";
    const std::string linkDelay = "1ms";
    const double simTime = 10.0;

    CommandLine cmd(__FILE__);
    cmd.AddValue("k", "Fat-tree degree (even, e.g. 4 or 8)", k);
    cmd.AddValue("queueSize", "Max queue size per link", queueSizeStr);
    cmd.AddValue("rate", "Per-flow application sending rate", sendingRateStr);
    cmd.AddValue("tcp", "TCP variant", tcpType);
    cmd.Parse(argc, argv);

    std::string tcpVariant = tcpType.substr(tcpType.rfind(':') + 1);
    std::string runTag = "k" + std::to_string(k)
        + "_q" + queueSizeStr
        + "_r" + sendingRateStr
        + "_tcp" + tcpVariant;
    
    for (auto& c : runTag) if (c == '/' || c == ' ') c = '_';
    std::string csvDir = csvBase + "/" + runTag;
    std::filesystem::create_directories(csvDir);

    if (k < 2 || k % 2 != 0)
    {
        std::cerr << "k must be even and >= 2\n";
        return 1;
    }

    FatTreeTopo topo(k);
    std::vector<FatTreeLink> links = topo.buildLinks();

    std::cout << "Fat-tree k=" << k
              << " hosts=" << topo.numHosts
              << " edge=" << topo.numEdge
              << " agg=" << topo.numAgg
              << " core=" << topo.numCore
              << " links=" << links.size() << "\n";

    Config::SetDefault("ns3::TcpL4Protocol::SocketType", StringValue(tcpType));
    Time::SetResolution(Time::NS);

    NodeContainer nodes;
    nodes.Create(topo.total);

    InternetStackHelper stack;
    stack.Install(nodes);

    TrafficControlHelper tch;
    tch.SetRootQueueDisc("ns3::FifoQueueDisc", "MaxSize", StringValue(queueSizeStr));

    std::vector<Ptr<QueueDisc>> qdiscsByLink;
    std::vector<Ipv4InterfaceContainer> interfacesByLink;

    Ipv4AddressHelper address;
    for (size_t i = 0; i < links.size(); ++i)
    {
        const auto& link = links[i];
        NodeContainer pair(nodes.Get(link.from), nodes.Get(link.to));

        PointToPointHelper p2p;
        p2p.SetDeviceAttribute("DataRate", StringValue(linkRate));
        p2p.SetChannelAttribute("Delay", StringValue(linkDelay));

        NetDeviceContainer devices = p2p.Install(pair);
        QueueDiscContainer qdiscs = tch.Install(devices);
        qdiscsByLink.push_back(qdiscs.Get(0));

        // Addressing: 10.B2.B3.0/24 to support up to ~64k links
        uint32_t byte2 = (uint32_t)(i / 254) + 1;
        uint32_t byte3 = (uint32_t)(i % 254) + 1;
        std::string subnet = "10." + std::to_string(byte2) + "." + std::to_string(byte3) + ".0";
        address.SetBase(subnet.c_str(), "255.255.255.0");
        interfacesByLink.push_back(address.Assign(devices));
    }

    Ipv4GlobalRoutingHelper::PopulateRoutingTables();

    // Random permutation traffic: host[i] -> host[perm[i]]
    // Host h's IP is interfacesByLink[h].GetAddress(0) (host is "from" in its host-edge link).
    Ptr<UniformRandomVariable> rng = CreateObject<UniformRandomVariable>();
    std::vector<uint32_t> perm(topo.numHosts);
    std::iota(perm.begin(), perm.end(), 0);
    for (uint32_t i = topo.numHosts - 1; i > 0; i--)
    {
        uint32_t j = static_cast<uint32_t>(rng->GetValue(0.0, static_cast<double>(i + 1)));
        std::swap(perm[i], perm[j]);
    }

    PacketSinkHelper sinkHelper("ns3::TcpSocketFactory",
        InetSocketAddress(Ipv4Address::GetAny(), basePort));
    for (uint32_t h = 0; h < topo.numHosts; h++)
    {
        ApplicationContainer sink = sinkHelper.Install(nodes.Get(h));
        sink.Start(Seconds(0.0));
        sink.Stop(Seconds(simTime + 1.0));
    }

    for (uint32_t h = 0; h < topo.numHosts; h++)
    {
        uint32_t dst = perm[h];
        if (dst == h)
            continue;

        Ipv4Address dstAddr = interfacesByLink[dst].GetAddress(0);

        // OnOffHelper: sends at constant rate when on, idle when off
        OnOffHelper onoff("ns3::TcpSocketFactory",
            InetSocketAddress(dstAddr, basePort));

        // Set constant sending rate and packet size
        onoff.SetConstantRate(DataRate(sendingRateStr), 1024);
        onoff.SetAttribute("OnTime",  StringValue("ns3::ConstantRandomVariable[Constant=1]"));
        onoff.SetAttribute("OffTime", StringValue("ns3::ConstantRandomVariable[Constant=0]"));

        ApplicationContainer src = onoff.Install(nodes.Get(h));
        src.Start(Seconds(1.0));
        src.Stop(Seconds(simTime));
    }

    CsvLogger csvLogger(csvDir);
    g_csvLogger = &csvLogger;

    const auto connectTraces = [&](Ptr<QueueDisc> qdisc, const std::string& linkId) {
        qdisc->TraceConnectWithoutContext("PacketsInQueue", MakeBoundCallback(&QueueLenTrace, linkId)); // # packets currently stored in the queue
        qdisc->TraceConnectWithoutContext("Drop", MakeBoundCallback(&DropTrace, linkId));
        qdisc->TraceConnectWithoutContext("Enqueue", MakeBoundCallback(&ArrivalTrace, linkId));
        qdisc->TraceConnectWithoutContext("Dequeue", MakeBoundCallback(&DequeueTrace, linkId));
    };

    for (size_t i = 0; i < links.size(); ++i)
        connectTraces(qdiscsByLink[i], links[i].id);

    Simulator::Stop(Seconds(simTime + 1.0)); // to allow processing of last packets
    Simulator::Run();

    csvLogger.CloseAll();
    g_csvLogger = nullptr;

    Simulator::Destroy();
    return 0;
}
