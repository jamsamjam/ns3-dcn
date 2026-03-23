// n0 -------------- n1 -------------- n2
//    point-to-point    point-to-point
//                      bottle-neck (!)
// TCP Data Center Scenario with Queue Analysis

#include "ns3/applications-module.h"
#include "ns3/core-module.h"
#include "ns3/internet-module.h"
#include "ns3/ipv4-global-routing-helper.h"
#include "ns3/network-module.h"
#include "ns3/point-to-point-module.h"
#include "ns3/traffic-control-module.h"
#include "ns3/tcp-l4-protocol.h"
// https://www.nsnam.org/docs/release/3.27/doxygen/group__traffic-control.html
#include <fstream>
#include <jsoncpp/json/json.h>

using namespace ns3;
using namespace Json;

NS_LOG_COMPONENT_DEFINE("SimpleTopology");

Value events(arrayValue);
std::map<Ptr<NetDevice>, uint32_t> deviceToLink;
uint16_t port = 9;

struct QueueMetrics
{
    uint32_t maxQueueSize = 0;
    uint32_t packetsLost = 0;
    uint32_t packetsQueued = 0;
    double totalSojournTime = 0.0;
    uint32_t sojournSampleCount = 0;
} queueMetrics;

static void
QueueLenTrace(uint32_t oldValue, uint32_t newValue)
{
    Value event;
    event["time"] = Simulator::Now().GetSeconds();
    event["type"] = "QUEUE_LEN_CHANGE";
    event["oldPackets"] = oldValue;
    event["newPackets"] = newValue;
    event["linkId"] = 1;
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
    Value event;
    event["time"] = Simulator::Now().GetSeconds();
    event["type"] = "SOJOURN_TIME";
    event["delayMs"] = t.GetMilliSeconds();
    event["linkId"] = 1;
    events.append(event);

    queueMetrics.totalSojournTime += t.GetMilliSeconds();
    queueMetrics.sojournSampleCount++;
}

static void
DropTrace(Ptr<const QueueDiscItem> item)
{
    Ptr<const Packet> packet = item->GetPacket();

    Value event;
    event["time"] = Simulator::Now().GetSeconds();
    event["type"] = "PACKET_DROP";
    event["packetId"] = packet->GetUid();
    event["size"] = packet->GetSize();
    event["linkId"] = 1;
    events.append(event);

    queueMetrics.packetsLost++;
}

int
main(int argc, char* argv[])
{
    std::string queueSizeStr = "100p";  // queue size in packets
    std::string sendingRateStr = "5Mbps"; // application sending rate
    std::string outputFilename = "../frontend/public/simple.json";
    double simTime = 10.0;
    
    CommandLine cmd(__FILE__);
    cmd.AddValue("queueSize", "Queue size (e.g., 100p, 1000p)", queueSizeStr);
    cmd.AddValue("rate", "Sending rate (e.g., 1Mbps, 5Mbps)", sendingRateStr);
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

    PointToPointHelper fastLink;
    PointToPointHelper slowLink;

    fastLink.SetDeviceAttribute("DataRate", StringValue("10Mbps"));
    fastLink.SetChannelAttribute("Delay", StringValue("10ms"));
    slowLink.SetDeviceAttribute("DataRate", StringValue("1Mbps"));
    slowLink.SetChannelAttribute("Delay", StringValue("50ms"));

    NetDeviceContainer d0d1 = fastLink.Install(n0n1);
    NetDeviceContainer d1d2 = slowLink.Install(n1n2);
    
    deviceToLink[d0d1.Get(0)] = 0;
    deviceToLink[d0d1.Get(1)] = 0;
    deviceToLink[d1d2.Get(0)] = 1;
    deviceToLink[d1d2.Get(1)] = 1;

    InternetStackHelper stack; 
    stack.Install(nodes);

    // Queue discipline on bottleneck link
    TrafficControlHelper tch;
    tch.SetRootQueueDisc("ns3::FifoQueueDisc", 
                         "MaxSize", StringValue(queueSizeStr));

    QueueDiscContainer qdiscs = tch.Install(d1d2);
    Ptr<QueueDisc> qdisc = qdiscs.Get(0); // get the queue disc at n1->n2

    Ipv4AddressHelper address;
    address.SetBase("10.1.1.0", "255.255.255.0");
    Ipv4InterfaceContainer i0i1 = address.Assign(d0d1);
    address.SetBase("10.1.2.0", "255.255.255.0");
    Ipv4InterfaceContainer i1i2 = address.Assign(d1d2);

    Ipv4GlobalRoutingHelper::PopulateRoutingTables();

    PacketSinkHelper sinkHelper("ns3::TcpSocketFactory",
                                InetSocketAddress(Ipv4Address::GetAny(), port));
    ApplicationContainer sinkApps = sinkHelper.Install(nodes.Get(2));
    sinkApps.Start(Seconds(0.0));
    sinkApps.Stop(Seconds(simTime + 1.0));

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

    // Trace queue length changes (number of packets)
    bool retval = qdisc->TraceConnectWithoutContext("PacketsInQueue",
                                MakeCallback(&QueueLenTrace));

    if (!retval)
    {
        std::cerr << "Warning: Could not connect PacketsInQueue trace" << std::endl;
    }

    // Trace sojourn time (time packets spend in queue)
    retval = qdisc->TraceConnectWithoutContext("SojournTime",
                                MakeCallback(&SojournTrace));
    if (!retval)
    {
        std::cerr << "Warning: Could not connect SojournTime trace" << std::endl;
    }

    // Trace dropped packets
    retval = qdisc->TraceConnectWithoutContext("Drop",
                                MakeCallback(&DropTrace));
    if (!retval)
    {
        std::cerr << "Warning: Could not connect Drop trace" << std::endl;
    }

    Simulator::Stop(Seconds(simTime + 1));
    Simulator::Run();
    
    // ---------- output results

    Value output;
    output["topology"] = "simple";
    output["queueSize"] = queueSizeStr;
    output["sendingRate"] = sendingRateStr;
    output["simTime"] = simTime;
    output["linkRate_fast"] = "10Mbps";
    output["linkRate_bottleneck"] = "1Mbps";
    output["events"] = events;
    
    Value metrics;
    metrics["maxQueueSize"] = queueMetrics.maxQueueSize;
    metrics["packetsLost"] = queueMetrics.packetsLost;
    metrics["packetsQueued"] = queueMetrics.packetsQueued;
    metrics["avgSojournTime"] = (queueMetrics.sojournSampleCount > 0) 
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
