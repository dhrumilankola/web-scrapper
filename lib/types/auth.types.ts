/**
 * Type Definitions for Auth Component Detection
 */

export interface AuthComponent {
    type: 'traditional' | 'oauth' | 'passwordless';
    snippet?: string;
    details: {
      fields?: string[];
      
      providers?: string[];
      
      method?: string;
      
      playwrightSelector?: string;
      extractionNote?: string;
    };
  }
  
  export interface DetectionResult {
    success: boolean;
    url: string;
    found: boolean;
    components: AuthComponent[];
    detectionMethod: 'ai' | 'pattern' | 'hybrid' | 'none';
    error?: string;
  }
  
  export interface AIDetectionResponse {
    found: boolean;
    components: Array<{
      type: 'traditional' | 'oauth' | 'passwordless';
      details: {
        fields?: string[];
        providers?: string[];
        method?: string;
        playwrightSelector?: string;
        extractionNote?: string;
      };
    }>;
  }