'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertCircle,
  FileQuestion,
  Github,
  KeyRound,
  Link,
  Loader,
  Search,
} from 'lucide-react';

interface AuthComponent {
  type: 'traditional' | 'oauth' | 'passwordless';
  snippet: string;
  details: {
    providers?: string[];
    fields?: string[];
    method?: string;
  };
}

interface DetectionResult {
  success: boolean;
  url: string;
  found: boolean;
  components: AuthComponent[];
  detectionMethod: 'ai' | 'pattern' | 'hybrid' | 'none';
  pageTitle?: string;
  screenshot?: string;
  error?: string;
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [error, setError] = useState('');

  const demoSites = [
    { name: 'GitHub', url: 'https://github.com/login' },
    { name: 'Google', url: 'https://accounts.google.com' },
    { name: 'Medium', url: 'https://medium.com/m/signin' },
    { name: 'LinkedIn', url: 'https://www.linkedin.com/login' },
    { name: 'Vercel', url: 'https://vercel.com/login' },
  ];

  useEffect(() => {
    console.log('🔄 [STATE CHANGE] Result updated:', {
      hasResult: !!result,
      found: result?.found,
      componentCount: result?.components?.length,
    });
  }, [result]);

  

  const handleSubmit = async (testUrl?: string) => {
    const targetUrl = testUrl || url;
    
    if (!targetUrl) {
      setError('Please enter a URL');
      return;
    }

    // Validate URL format
    try {
      const urlObj = new URL(targetUrl);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch (_err) {
      setError('Please enter a valid URL (must start with http:// or https://)');
      return;
    }
  
    setLoading(true);
    setError('');
    setResult(null);
  
    try {
      console.log('🚀 [SUBMIT] Starting detection for:', targetUrl);
      
      const apiEndpoint = process.env['NEXT_PUBLIC_API_ENDPOINT'] || '/api/detect';
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: targetUrl }),
      });
  
      console.log('📡 [RESPONSE] Status:', response.status, response.statusText);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Something went wrong');
      }

      const data: DetectionResult = await response.json();
      setResult(data);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('An unknown error occurred');
      }
    } finally {
      setLoading(false);
      console.log('🏁 [COMPLETE] Request completed');
    }
  };


  return (
    <div className="container mx-auto p-4 md:p-8">
      <header className="text-center mb-12">
        <h1 className="text-4xl md:text-5xl font-bold mb-4 tracking-tighter">
          Auth Component Detector
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto">
          An AI-powered tool to detect and analyze authentication components on any website.
        </p>
      </header>

      <main className="max-w-4xl mx-auto space-y-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="w-6 h-6" />
              Detect Authentication
            </CardTitle>
            <CardDescription>
              Enter a URL to analyze its authentication methods.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-3">
              <Input
                type="url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (error) setError('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                placeholder="https://example.com/login"
                className={`flex-1 text-base ${error ? 'border-destructive' : ''}`}
                disabled={loading}
              />
              <Button onClick={() => handleSubmit()} disabled={loading} size="lg">
                {loading ? (
                  <>
                    <Loader className="mr-2 h-4 w-4 animate-spin" />
                    Detecting...
                  </>
                ) : (
                  'Detect'
                )}
              </Button>
            </div>
          </CardContent>
          <CardFooter>
            <div className="space-x-2">
              <span className="text-sm text-muted-foreground">Quick Tests:</span>
              {demoSites.map((site) => (
                <Button
                  key={site.name}
                  variant="outline"
                  size="sm"
                  onClick={() => handleSubmit(site.url)}
                  disabled={loading}
                >
                  {site.name}
                </Button>
              ))}
            </div>
          </CardFooter>
        </Card>

        {loading && (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="flex items-center space-x-3 text-lg">
              <Loader className="h-6 w-6 animate-spin text-primary" />
              <span>Analyzing website...</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              It may take up to 30-60 seconds for some websites.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              May not work for banking websites or websites with strict bot security.
            </p>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && !loading && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {result.found ? (
                  <KeyRound className="h-6 w-6 text-green-500" />
                ) : (
                  <FileQuestion className="h-6 w-6 text-yellow-500" />
                )}
                {result.found
                  ? `Found ${result.components.length} Auth Method(s)`
                  : 'No Authentication Found'}
              </CardTitle>
              <CardDescription>
                Analysis of {result.url} (using {result.detectionMethod.toUpperCase()})
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {result.screenshot && (
                <div>
                  <h3 className="text-lg font-medium mb-2">Screenshot</h3>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={result.screenshot}
                    alt="Page screenshot"
                    className="w-full rounded-lg border"
                  />
                </div>
              )}

              {result.found && result.components.length > 0 && (
                <Accordion type="single" collapsible className="w-full">
                  {result.components.map((component, index) => (
                    <AccordionItem value={`item-${index}`} key={index}>
                      <AccordionTrigger className="text-lg">
                        <div className="flex items-center gap-2">
                          {component.type === 'traditional' && <KeyRound className="w-5 h-5" />}
                          {component.type ==='oauth' && <Github className="w-5 h-5" />}
                          {component.type === 'passwordless' && <Link className="w-5 h-5" />}
                          <span className="capitalize">{component.type}</span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="space-y-4">
                        {component.details.providers && (
                          <p>
                            <strong>Providers:</strong> {component.details.providers.join(', ')}
                          </p>
                        )}
                        {component.details.fields && (
                          <p>
                            <strong>Fields:</strong> {component.details.fields.join(', ')}
                          </p>
                        )}
                        {component.details.method && (
                          <p>
                            <strong>Method:</strong> {component.details.method}
                          </p>
                        )}
                        {component.snippet && !component.snippet.includes('could not extract') && (
                          <div>
                            <h4 className="font-semibold mb-2">HTML Snippet:</h4>
                            <pre className="bg-muted p-4 rounded-lg text-sm overflow-x-auto">
                              <code>{component.snippet}</code>
                            </pre>
                          </div>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              )}

              {!result.found && (
                <Alert variant="default">
                  <FileQuestion className="h-4 w-4" />
                  <AlertTitle>No components detected.</AlertTitle>
                  <AlertDescription>
                    This could mean the page doesn&apos;t have a login form, or it&apos;s loaded
                    dynamically.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}

        <footer className="text-center text-sm text-muted-foreground">
          <p>
            Powered by Next.js, Playwright, and Gemini AI.
          </p>
          <p>
            Made by{' '}
            <a
              href="https://github.com/dhrumil"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold hover:underline"
            >
              Dhrumil Ankola
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}