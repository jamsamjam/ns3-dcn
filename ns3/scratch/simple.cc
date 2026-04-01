#include "ns3/applications-module.h"
#include "ns3/core-module.h"
#include "ns3/internet-module.h"
#include "ns3/ipv4-global-routing-helper.h"
#include "ns3/network-module.h"
#include "ns3/point-to-point-module.h"
#include "ns3/traffic-control-module.h"
#include "ns3/tcp-l4-protocol.h"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <string>
#include <unordered_map>
#include <vector>

#include <json/json.h>

using namespace ns3;
using namespace Json;

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
    std::string label;
};

struct LinkTraceData
{
    Value queueLenChanges{arrayValue};
    Value sojournSamples{arrayValue};
    Value packetDrops{arrayValue};
    Value packetDequeues{arrayValue};
    QueueMetrics metrics;
};

static std::unordered_map<std::string, LinkTraceData> tracesByLink;

// https://www.nsnam.org/docs/manual/html/tracing.html
// trace source -> trace sink (callback function)
// called whenever an event occurs that we want to trace

static void
QueueLenTrace(std::string linkId, uint32_t oldValue, uint32_t newValue)
{
    Value event(objectValue);
    event["time"] = Simulator::Now().GetSeconds();
    event["oldPackets"] = oldValue;
    event["newPackets"] = newValue;

    auto& trace = tracesByLink[linkId];
    trace.queueLenChanges.append(event);

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

    Value event(objectValue);
    event["time"] = Simulator::Now().GetSeconds();
    event["delayMs"] = delayMs;

    auto& trace = tracesByLink[linkId];
    trace.sojournSamples.append(event);

    trace.metrics.totalSojournTime += delayMs;
    trace.metrics.sojournSampleCount++;
}

static void
DropTrace(std::string linkId, Ptr<const QueueDiscItem> item)
{
    Ptr<const Packet> packet = item->GetPacket();

    Value event(objectValue);
    event["time"] = Simulator::Now().GetSeconds();
    event["packetId"] = static_cast<Json::UInt64>(packet->GetUid());
    event["size"] = packet->GetSize();

    auto& trace = tracesByLink[linkId];
    trace.packetDrops.append(event);
    trace.metrics.packetsLost++;
}

static void
DequeueTrace(std::string linkId, Ptr<const QueueDiscItem> item)
{
    Ptr<const Packet> packet = item->GetPacket();

    Value event(objectValue);
    event["time"] = Simulator::Now().GetSeconds();
    event["packetId"] = static_cast<Json::UInt64>(packet->GetUid());
    event["size"] = packet->GetSize(); // in bytes

    tracesByLink[linkId].packetDequeues.append(event);
}

int
main(int argc, char* argv[])
{
    std::string queueSizeStr = "100p";
    std::string sendingRateStr = "5Mbps";
    std::string outputFilename = "../frontend/public/simple.json";
    double simTime = 10.0;

    // e.g. ./ns3 run "scratch/<file> --queueSize=50p --rate=8Mbps --time=20"
    CommandLine cmd(__FILE__);
    cmd.AddValue("queueSize", "Queue size (e.g. 100p, 1000p)", queueSizeStr);
    cmd.AddValue("rate", "Sending rate (e.g. 1Mbps, 5Mbps)", sendingRateStr);
    cmd.AddValue("time", "Simulation time in seconds", simTime);
    cmd.AddValue("output", "Output JSON path", outputFilename);
    cmd.Parse(argc, argv);

    Time::SetResolution(Time::NS);

    NodeContainer nodes;
    nodes.Create(3);

    NodeContainer n0n1(nodes.Get(0), nodes.Get(1));
    NodeContainer n1n2(nodes.Get(1), nodes.Get(2));

    std::vector<LinkInfo> linkInfos = {
        {"n0-n1", 0, 1, "10Mbps", "10ms", "fast"},
        {"n1-n2", 1, 2, "1Mbps", "50ms", "bottleneck"},
    };

    const std::string tracedLinkId = linkInfos[1].linkId;

    PointToPointHelper fastLink;
    PointToPointHelper slowLink;

    fastLink.SetDeviceAttribute("DataRate", StringValue(linkInfos[0].rate));
    fastLink.SetChannelAttribute("Delay", StringValue(linkInfos[0].delay));
    slowLink.SetDeviceAttribute("DataRate", StringValue(linkInfos[1].rate));
    slowLink.SetChannelAttribute("Delay", StringValue(linkInfos[1].delay));

    NetDeviceContainer d0d1 = fastLink.Install(n0n1);
    NetDeviceContainer d1d2 = slowLink.Install(n1n2);

    InternetStackHelper stack;
    stack.Install(nodes);

    TrafficControlHelper tch;
    tch.SetRootQueueDisc("ns3::FifoQueueDisc", "MaxSize", StringValue(queueSizeStr));

    QueueDiscContainer qdiscs = tch.Install(d1d2);
    Ptr<QueueDisc> qdisc = qdiscs.Get(0);

    Ipv4AddressHelper address;
    address.SetBase("10.1.1.0", "255.255.255.0");
    Ipv4InterfaceContainer i0i1 = address.Assign(d0d1);
    address.SetBase("10.1.2.0", "255.255.255.0");
    Ipv4InterfaceContainer i1i2 = address.Assign(d1d2);

    Ipv4GlobalRoutingHelper::PopulateRoutingTables();

    PacketSinkHelper sinkHelper(
        "ns3::TcpSocketFactory",
        InetSocketAddress(Ipv4Address::GetAny(), port));
    ApplicationContainer sinkApps = sinkHelper.Install(nodes.Get(2));
    sinkApps.Start(Seconds(0.0));
    sinkApps.Stop(Seconds(simTime + 1.0)); // to allow processing of last packets

    // OnOffHelper: sends at constant rate when on, idle when off
    OnOffHelper onoffHelper("ns3::TcpSocketFactory",
                            InetSocketAddress(i1i2.GetAddress(1), port));
    // Set constant sending rate and packet size
    onoffHelper.SetConstantRate(DataRate(sendingRateStr), 1024);
    onoffHelper.SetAttribute("OnTime", StringValue("ns3::ConstantRandomVariable[Constant=10.0]"));
    onoffHelper.SetAttribute("OffTime", StringValue("ns3::ConstantRandomVariable[Constant=0.0]"));

    ApplicationContainer sendApps = onoffHelper.Install(nodes.Get(0));
    sendApps.Start(Seconds(1.0));
    sendApps.Stop(Seconds(simTime));

    qdisc->TraceConnectWithoutContext(
        "PacketsInQueue",
        MakeBoundCallback(&QueueLenTrace, tracedLinkId));

    qdisc->TraceConnectWithoutContext(
        "SojournTime",
        MakeBoundCallback(&SojournTrace, tracedLinkId));

    qdisc->TraceConnectWithoutContext(
        "Drop",
        MakeBoundCallback(&DropTrace, tracedLinkId));

    qdisc->TraceConnectWithoutContext(
        "Dequeue",
        MakeBoundCallback(&DequeueTrace, tracedLinkId));

    Simulator::Stop(Seconds(simTime + 1.0));
    Simulator::Run();

    Value output(objectValue);
    output["topology"] = "simple";
    output["simTime"] = simTime;
    output["queueSize"] = queueSizeStr;
    output["sendingRate"] = sendingRateStr;

    Value linksArray(arrayValue);
    for (const auto& link : linkInfos)
    {
        Value l(objectValue);
        l["linkId"] = link.linkId;
        l["from"] = link.from;
        l["to"] = link.to;
        l["rate"] = link.rate;
        l["delay"] = link.delay;
        l["label"] = link.label;

        const auto it = tracesByLink.find(link.linkId);
        if (it != tracesByLink.end())
        {
            const auto& trace = it->second;

            Value traceJson(objectValue);
            traceJson["queueLenChanges"] = trace.queueLenChanges;
            traceJson["sojournSamples"] = trace.sojournSamples;
            traceJson["packetDrops"] = trace.packetDrops;
            traceJson["packetDequeues"] = trace.packetDequeues;

            Value metrics(objectValue);
            metrics["maxQueueSize"] = trace.metrics.maxQueueSize;
            metrics["packetsLost"] = trace.metrics.packetsLost;
            metrics["packetsQueued"] = trace.metrics.packetsQueued;
            metrics["avgSojournTime"] =
                (trace.metrics.sojournSampleCount > 0)
                    ? (trace.metrics.totalSojournTime / trace.metrics.sojournSampleCount)
                    : 0.0;

            traceJson["metrics"] = metrics;
            l["trace"] = traceJson;
        }

        linksArray.append(l);
    }

    output["links"] = linksArray;

    std::ofstream outfile(outputFilename);
    if (outfile.is_open())
    {
        StreamWriterBuilder builder;
        builder["indentation"] = "  ";
        outfile << Json::writeString(builder, output);
        outfile.close();
    }

    Simulator::Destroy();
    return 0;
}