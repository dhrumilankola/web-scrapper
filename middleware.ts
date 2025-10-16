import { NextRequest, NextResponse } from 'next/server';

const allowedOrigins = [
  'https://web-scrapper-ecru.vercel.app',
  'http://localhost:3000',
];

// This function can be marked `async` if using `await` inside
export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin');
  
  // Create a new response so we can modify headers
  const response = request.method === 'OPTIONS' 
    ? new NextResponse(null, { status: 204 }) 
    : NextResponse.next();

  // Add the CORS headers to the response
  if (origin && allowedOrigins.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
  }
  
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // For OPTIONS requests, we want to return immediately with the headers
  if (request.method === 'OPTIONS') {
    return response;
  }

  // For other requests, continue to the API route
  return response;
}

// See "Matching Paths" below to learn more
export const config = {
  matcher: '/api/detect',
};
