// n0 -------------- n1 -------------- n2
//    point-to-point    point-to-point
//                      bottleneck (!)

#include "ns3/applications-module.h"
#include "ns3/core-module.h"
#include "ns3/internet-module.h"
#include "ns3/ipv4-global-routing-helper.h"
#include "ns3/network-module.h"
#include "ns3/point-to-point-module.h"
#include "ns3/traffic-control-module.h"
#include "ns3/tcp-l4-protocol.h"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include <json/json.h>

using namespace ns3;
using namespace Json;

NS_LOG_COMPONENT_DEFINE("SimpleTopology");

static Value events(arrayValue);
static uint16_t port = 9;

// the link to trace
static const std::string bottleneckLinkId = "n1-n2";

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

// https://www.nsnam.org/docs/manual/html/tracing.html
// trace source -> trace sink (callback function)
// called whenever an event occurs that we want to trace

static QueueMetrics queueMetrics;

static void
QueueLenTrace(uint32_t oldValue, uint32_t newValue)
{
    Value event(objectValue);
    event["time"] = Simulator::Now().GetSeconds();
    event["type"] = "QUEUE_LEN_CHANGE";
    event["linkId"] = bottleneckLinkId;
    event["oldPackets"] = oldValue;
    event["newPackets"] = newValue;
    events.append(event);

    queueMetrics.maxQueueSize = std::max(queueMetrics.maxQueueSize, newValue);

    if (newValue > oldValue)
    {
        queueMetrics.packetsQueued += (newValue - oldValue);
    }
}

static void
SojournTrace(Time t)
{
    const double delayMs = t.GetNanoSeconds() / 1e6;

    Value event(objectValue);
    event["time"] = Simulator::Now().GetSeconds();
    event["type"] = "SOJOURN_TIME";
    event["linkId"] = bottleneckLinkId;
    event["delayMs"] = delayMs;
    events.append(event);

    queueMetrics.totalSojournTime += delayMs;
    queueMetrics.sojournSampleCount++;
}

static void
DropTrace(Ptr<const QueueDiscItem> item)
{
    Ptr<const Packet> packet = item->GetPacket();

    Value event(objectValue);
    event["time"] = Simulator::Now().GetSeconds();
    event["type"] = "PACKET_DROP";
    event["linkId"] = bottleneckLinkId;
    event["packetId"] = packet->GetUid();
    event["size"] = packet->GetSize(); // in bytes
    events.append(event);

    queueMetrics.packetsLost++; // dropped by qdisc
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

    LogComponentEnable("TcpL4Protocol", LOG_LEVEL_INFO);
    LogComponentEnable("OnOffApplication", LOG_LEVEL_INFO);

    NodeContainer nodes;
    nodes.Create(3);

    NodeContainer n0n1(nodes.Get(0), nodes.Get(1));
    NodeContainer n1n2(nodes.Get(1), nodes.Get(2));

    std::vector<LinkInfo> linkInfos = {
        {"n0-n1", 0, 1, "10Mbps", "10ms", "fast"},
        {"n1-n2", 1, 2, "1Mbps", "50ms", "bottleneck"},
    };

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

    // Queue discipline on bottleneck link
    TrafficControlHelper tch;
    tch.SetRootQueueDisc("ns3::FifoQueueDisc", "MaxSize", StringValue(queueSizeStr));

    QueueDiscContainer qdiscs = tch.Install(d1d2);
    Ptr<QueueDisc> qdisc = qdiscs.Get(0); // TODO: assume bottlenek is n1->n2

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

    bool retval = qdisc->TraceConnectWithoutContext(
        "PacketsInQueue",
        MakeCallback(&QueueLenTrace));
    if (!retval)
    {
        std::cerr << "Warning: Could not connect PacketsInQueue trace" << std::endl;
    }

    retval = qdisc->TraceConnectWithoutContext( 
        "SojournTime", // calculated at the moment when a packet dequeued at queue disc
        MakeCallback(&SojournTrace));
    if (!retval)
    {
        std::cerr << "Warning: Could not connect SojournTime trace" << std::endl;
    }

    retval = qdisc->TraceConnectWithoutContext(
        "Drop",
        MakeCallback(&DropTrace));
    if (!retval)
    {
        std::cerr << "Warning: Could not connect Drop trace" << std::endl;
    }

    Simulator::Stop(Seconds(simTime + 1.0));
    Simulator::Run();

    Value output(objectValue);
    output["topology"] = "simple";
    output["queueSize"] = queueSizeStr;
    output["sendingRate"] = sendingRateStr;
    output["simTime"] = simTime;
    output["events"] = events;

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
        linksArray.append(l);
    }
    output["links"] = linksArray;

    Value metrics(objectValue);
    metrics["maxQueueSize"] = queueMetrics.maxQueueSize;
    metrics["packetsLost"] = queueMetrics.packetsLost;
    metrics["packetsQueued"] = queueMetrics.packetsQueued;
    metrics["avgSojournTime"] =
        (queueMetrics.sojournSampleCount > 0)
            ? (queueMetrics.totalSojournTime / queueMetrics.sojournSampleCount)
            : 0.0;
    output["metrics"] = metrics;

    std::ofstream outfile(outputFilename);
    if (outfile.is_open())
    {
        FastWriter writer;
        outfile << writer.write(output);
        outfile.close();
        NS_LOG_INFO("Trace saved to: " << outputFilename);
    }
    else
    {
        NS_LOG_ERROR("Could not open output file: " << outputFilename);
    }

    Simulator::Destroy();
    return 0;
}