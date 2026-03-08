// n0 -------------- n1 -------------- n2
//    point-to-point    point-to-point

#include "ns3/applications-module.h"
#include "ns3/core-module.h"
#include "ns3/internet-module.h"
#include "ns3/ipv4-global-routing-helper.h"
#include "ns3/network-module.h"
#include "ns3/point-to-point-module.h"
#include <fstream>
#include <json/json.h>

using namespace ns3;
using namespace Json;

NS_LOG_COMPONENT_DEFINE("SimpleTopology");

Value events(arrayValue); // same as events = Json::arrayValue;

static void
PacketTxTrace(Ptr<const Packet> packet)
{
    Value event;
    event["time"] = Simulator::Now().GetSeconds();
    event["type"] = "TX";
    event["size"] = (int)packet->GetSize();
    events.append(event);
}

static void
PacketRxTrace(Ptr<const Packet> packet)
{
    Value event;
    event["time"] = Simulator::Now().GetSeconds();
    event["type"] = "RX";
    event["size"] = (int)packet->GetSize();
    events.append(event);
}

int
main(int argc, char* argv[])
{
    CommandLine cmd(__FILE__);
    cmd.Parse(argc, argv);

    Time::SetResolution(Time::NS);
    LogComponentEnable("UdpEchoClientApplication", LOG_LEVEL_INFO);
    LogComponentEnable("UdpEchoServerApplication", LOG_LEVEL_INFO);

    NodeContainer nodes;
    nodes.Create(3);

    NodeContainer n0n1(nodes.Get(0), nodes.Get(1));
    NodeContainer n1n2(nodes.Get(1), nodes.Get(2));

    PointToPointHelper pointToPoint;
    std::string dataRate = "1Gbps";
    std::string delay = "2ms";
    pointToPoint.SetDeviceAttribute("DataRate", StringValue(dataRate));
    pointToPoint.SetChannelAttribute("Delay", StringValue(delay));

    NetDeviceContainer d0d1 = pointToPoint.Install(n0n1);
    NetDeviceContainer d1d2 = pointToPoint.Install(n1n2);

    InternetStackHelper stack; 
    stack.Install(nodes);

    Ipv4AddressHelper address;
    address.SetBase("10.1.1.0", "255.255.255.0");
    Ipv4InterfaceContainer i0i1 = address.Assign(d0d1);
    address.SetBase("10.1.2.0", "255.255.255.0");
    Ipv4InterfaceContainer i1i2 = address.Assign(d1d2);

    Ipv4GlobalRoutingHelper::PopulateRoutingTables();

    UdpEchoServerHelper echoServer(9);
    ApplicationContainer serverApps = echoServer.Install(nodes.Get(2));
    serverApps.Start(Seconds(1));
    serverApps.Stop(Seconds(10));

    UdpEchoClientHelper echoClient(i1i2.GetAddress(1), 9);
    echoClient.SetAttribute("MaxPackets", UintegerValue(1));
    echoClient.SetAttribute("Interval", TimeValue(Seconds(1)));
    echoClient.SetAttribute("PacketSize", UintegerValue(1024));

    ApplicationContainer clientApps = echoClient.Install(nodes.Get(0));
    clientApps.Start(Seconds(2));
    clientApps.Stop(Seconds(10));

    Config::ConnectWithoutContext(
    "/NodeList/*/DeviceList/*/$ns3::PointToPointNetDevice/MacTx",
    MakeCallback(&PacketTxTrace)
    );

    Config::ConnectWithoutContext(
    "/NodeList/*/DeviceList/*/$ns3::PointToPointNetDevice/MacRx",
    MakeCallback(&PacketRxTrace)
    );

    Simulator::Stop(Seconds(11));
    Simulator::Run();
    
    Value root;
    
    Value topology;
    Value jsonNodes(arrayValue);
    
    for (uint32_t i = 0; i < nodes.GetN(); i++)
    {
        Value node;
        node["id"] = i;
        
        if (i == 0)
            node["name"] = "Client";
        else if (i == nodes.GetN() - 1)
            node["name"] = "Server";
        else
            node["name"] = "Router";
        
        node["x"] = 100 + (i * 200);
        node["y"] = 200;
        
        jsonNodes.append(node);
    }
    
    topology["nodes"] = jsonNodes;
    
    Value links(arrayValue);
    
    for (uint32_t i = 0; i < nodes.GetN() - 1; i++)
    {
        Value link;
        link["source"] = i;
        link["target"] = i + 1;
        link["dataRate"] = dataRate;
        link["delay"] = delay;
        links.append(link);
    }
    
    topology["links"] = links;
    root["topology"] = topology;
    root["events"] = events;
    
    StreamWriterBuilder builder;
    builder["commentStyle"] = "None";
    builder["indentation"] = "  ";
    
    std::ofstream jsonFile("../backend/output/simple.json");
    std::unique_ptr<StreamWriter> writer(
        builder.newStreamWriter());
    writer->write(root, &jsonFile);
    jsonFile.close();
    
    std::cout << "Simulation results saved to json" << std::endl;
    
    Simulator::Destroy();
    return 0;
}