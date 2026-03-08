import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), '..', 'backend', 'output', 'simple.json');
    
    if (!fs.existsSync(filePath)) {
      return NextResponse.json(
        { error: 'Simulation data not found.' },
        { status: 404 }
      );
    }

    const fileContents = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(fileContents);

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error reading simulation data:', error);
    return NextResponse.json(
      { error: 'Failed to read simulation data' },
      { status: 500 }
    );
  }
}
