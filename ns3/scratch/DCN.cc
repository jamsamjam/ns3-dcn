// Referenced from:
// https://ns3simulation.com/how-to-implement-data-center-networking-in-ns3/

#include "ns3/core-module.h"
#include "ns3/network-module.h"
#include "ns3/internet-module.h"
#include "ns3/point-to-point-module.h"
#include "ns3/applications-module.h"

using namespace ns3;

class ServerApplication : public Application {
public:
    void StartApplication() override {
        recvSocket = Socket::CreateSocket(GetNode(), TcpSocketFactory::GetTypeId());
        recvSocket->Bind(InetSocketAddress(Ipv4Address::GetAny(), 9));
        recvSocket->Listen();
        recvSocket->SetAcceptCallback(
            MakeNullCallback<bool, Ptr<Socket>, const Address &>(),
            MakeCallback(&ServerApplication::HandleAccept, this)
        );
        recvSocket->SetRecvCallback(MakeCallback(&ServerApplication::HandleRead, this));
    }

    void HandleAccept(Ptr<Socket> socket, const Address& from) {
        socket->SetRecvCallback(MakeCallback(&ServerApplication::HandleRead, this));
    }

    void HandleRead(Ptr<Socket> socket) {
        Ptr<Packet> packet;
        while ((packet = socket->Recv())) {
            std::cout << "Server received packet of size "
                      << packet->GetSize()
                      << " bytes"
                      << std::endl;
        }
    }

private:
    Ptr<Socket> recvSocket;
};

class ClientApplication : public Application {
public:
    void StartApplication() override {
        sendSocket = Socket::CreateSocket(GetNode(), TcpSocketFactory::GetTypeId());
        InetSocketAddress remote = InetSocketAddress(serverAddress, 9);
        sendSocket->Connect(remote);

        // Schedule the first packet send
        Simulator::Schedule(Seconds(1.0), &ClientApplication::SendPacket, this);
    }

    void SetServerAddress(Ipv4Address address) {
        serverAddress = address;
    }

    void SendPacket() {
        Ptr<Packet> packet = Create<Packet>(100); // Create a 100-byte packet
        sendSocket->Send(packet);

        // Schedule the next packet send
        Simulator::Schedule(Seconds(1.0), &ClientApplication::SendPacket, this);
    }

private:
    Ptr<Socket> sendSocket;
    Ipv4Address serverAddress;
};

int main(int argc, char *argv[]) {
    NodeContainer coreSwitches, aggSwitches, edgeSwitches, servers;

    uint32_t k = 4; // Number of ports per switch (k must be even for fat-tree topology)
    uint32_t numPods = k; // Number of pods
    uint32_t numCoreSwitches = (k / 2) * (k / 2);
    uint32_t numAggSwitches = k * (k / 2);
    uint32_t numEdgeSwitches = k * (k / 2);
    uint32_t numServers = k * numEdgeSwitches / 2;

    coreSwitches.Create(numCoreSwitches);
    aggSwitches.Create(numAggSwitches);
    edgeSwitches.Create(numEdgeSwitches);
    servers.Create(numServers);

    PointToPointHelper p2p;
    p2p.SetDeviceAttribute("DataRate", StringValue("1Gbps"));
    p2p.SetChannelAttribute("Delay", StringValue("2ms"));

    NetDeviceContainer coreDevices, aggDevices, edgeDevices;

    for (uint32_t i = 0; i < coreSwitches.GetN(); ++i) {
        for (uint32_t j = 0; j < aggSwitches.GetN() / numPods; ++j) {
            NetDeviceContainer link = p2p.Install(
                NodeContainer(
                    coreSwitches.Get(i),
                    aggSwitches.Get(j + (i / (k / 2)) * (k / 2))
                )
            );
            coreDevices.Add(link);
        }
    }

    for (uint32_t i = 0; i < aggSwitches.GetN(); ++i) {
        for (uint32_t j = 0; j < edgeSwitches.GetN() / numPods; ++j) {
            NetDeviceContainer link = p2p.Install(
                NodeContainer(
                    aggSwitches.Get(i),
                    edgeSwitches.Get(j + (i / (k / 2)) * (k / 2))
                )
            );
            aggDevices.Add(link);
        }
    }

    for (uint32_t i = 0; i < edgeSwitches.GetN(); ++i) {
        for (uint32_t j = 0; j < numServers / numEdgeSwitches; ++j) {
            NetDeviceContainer link = p2p.Install(
                NodeContainer(
                    edgeSwitches.Get(i),
                    servers.Get(j + i * (numServers / numEdgeSwitches))
                )
            );
            edgeDevices.Add(link);
        }
    }

    InternetStackHelper internet;
    internet.Install(coreSwitches);
    internet.Install(aggSwitches);
    internet.Install(edgeSwitches);
    internet.Install(servers);

    Ipv4AddressHelper address;
    Ipv4InterfaceContainer coreInterfaces, aggInterfaces, edgeInterfaces, serverInterfaces;

    address.SetBase("10.1.0.0", "255.255.255.0");
    coreInterfaces = address.Assign(coreDevices);

    address.SetBase("10.2.0.0", "255.255.255.0");
    aggInterfaces = address.Assign(aggDevices);

    address.SetBase("10.3.0.0", "255.255.255.0");
    edgeInterfaces = address.Assign(edgeDevices);

    address.SetBase("10.4.0.0", "255.255.255.0");
    serverInterfaces = address.Assign(servers);

    ApplicationContainer serverApps, clientApps;

    for (uint32_t i = 0; i < servers.GetN(); ++i) {
        Ptr<ServerApplication> serverApp = CreateObject<ServerApplication>();
        servers.Get(i)->AddApplication(serverApp);
        serverApp->SetStartTime(Seconds(0.0));
        serverApp->SetStopTime(Seconds(20.0));
        serverApps.Add(serverApp);
    }

    for (uint32_t i = 0; i < 5; ++i) {
        Ptr<ClientApplication> clientApp = CreateObject<ClientApplication>();
        clientApp->SetServerAddress(
            servers.Get((i + 1) % servers.GetN())
                ->GetObject<Ipv4>()
                ->GetAddress(1, 0)
                .GetLocal()
        );
        servers.Get(i)->AddApplication(clientApp);
        clientApp->SetStartTime(Seconds(1.0));
        clientApp->SetStopTime(Seconds(20.0));
        clientApps.Add(clientApp);
    }

    Simulator::Stop(Seconds(20.0));
    Simulator::Run();
    Simulator::Destroy();

    return 0;
}

