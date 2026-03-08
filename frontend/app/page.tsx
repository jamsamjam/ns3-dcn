import NetworkView from "@/components/NetworkView";

async function getData() {
  try {
    const res = await fetch("http://localhost:3000/api/events", {
      cache: 'no-store' // Disable caching to get fresh data
    });
    
    if (!res.ok) {
      throw new Error(`Failed to fetch: ${res.status}`);
    }
    
    return res.json();
  } catch (error) {
    console.error('Error fetching data:', error);
    return null;
  }
}

export default async function Home() {
  const data = await getData();

  return (
    <main style={{ padding: 40 }}>
      {data ? (
        <NetworkView data={data} />
      ) : (
        <div>
          <p>No simulation data available.</p>
        </div>
      )}
    </main>
  );
}
