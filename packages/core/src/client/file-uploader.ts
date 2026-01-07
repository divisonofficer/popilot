/**
 * File Uploader for POSTECH GenAI API
 * Uploads files using SSO bearer token and returns file IDs for A2 API
 */

export interface UploadedFile {
  id: string;
  name: string;
  /** Server URL for the uploaded file (used in A2 API) */
  url: string;
}

export interface FileUploadRequest {
  filename: string;
  content: string;  // raw content (not base64)
  mimeType?: string;
}

export interface FileUploaderConfig {
  uploadUrl?: string;
  siteName?: string;
}

/**
 * Get MIME type from filename extension.
 */
export function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mimeTypes: Record<string, string> = {
    ts: 'text/typescript',
    tsx: 'text/typescript',
    js: 'text/javascript',
    jsx: 'text/javascript',
    json: 'application/json',
    md: 'text/markdown',
    py: 'text/x-python',
    rs: 'text/x-rust',
    go: 'text/x-go',
    java: 'text/x-java',
    cpp: 'text/x-c++',
    c: 'text/x-c',
    h: 'text/x-c',
    css: 'text/css',
    html: 'text/html',
    xml: 'text/xml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    sh: 'text/x-shellscript',
    txt: 'text/plain',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
  };
  return mimeTypes[ext] ?? 'text/plain';
}

/**
 * FileUploader - uploads files to POSTECH GenAI file API.
 * Requires SSO bearer token for authentication.
 */
export class FileUploader {
  private baseUrl: string;
  private uploadUrl: string;
  private siteName: string;

  constructor(config: FileUploaderConfig = {}) {
    this.baseUrl = 'https://genai.postech.ac.kr';
    this.siteName = config.siteName ?? 'robi-gpt-dev';
    this.uploadUrl = config.uploadUrl ??
      `${this.baseUrl}/v2/athena/chats/m1/files?site_name=${this.siteName}`;
  }

  /**
   * Build the server URL for an uploaded file.
   * This URL is used in A2 API to reference the uploaded file.
   */
  private buildFileUrl(fileId: string): string {
    return `${this.baseUrl}/v2/athena/chats/m1/files/${fileId}?site_name=${this.siteName}`;
  }

  /**
   * Upload a single file using SSO bearer token.
   * @param token - SSO bearer token
   * @param file - File to upload
   * @returns UploadedFile with id and name from server
   */
  async upload(token: string, file: FileUploadRequest): Promise<UploadedFile> {
    const mimeType = file.mimeType ?? getMimeType(file.filename);

    // Create multipart/form-data boundary
    const boundary = `----WebKitFormBoundary${Date.now().toString(16)}`;

    // Build multipart body manually for Node.js compatibility
    const body = this.buildMultipartBody(boundary, file.filename, file.content, mimeType);

    const response = await fetch(this.uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new FileUploadError(
        `File upload failed: ${response.status} ${response.statusText}`,
        response.status,
        errorText
      );
    }

    const result = await response.json() as { files: Array<{ id: string; name: string }> };

    if (!result.files || result.files.length === 0) {
      throw new FileUploadError('No file returned from upload', 0, JSON.stringify(result));
    }

    const uploadedFile = result.files[0];
    // Construct the server URL for the uploaded file
    return {
      id: uploadedFile.id,
      name: uploadedFile.name,
      url: this.buildFileUrl(uploadedFile.id),
    };
  }

  /**
   * Upload multiple files.
   * @param token - SSO bearer token
   * @param files - Files to upload
   * @returns Array of UploadedFile
   */
  async uploadMultiple(token: string, files: FileUploadRequest[]): Promise<UploadedFile[]> {
    // Upload files sequentially to avoid overwhelming the server
    const results: UploadedFile[] = [];
    for (const file of files) {
      const uploaded = await this.upload(token, file);
      results.push(uploaded);
    }
    return results;
  }

  /**
   * Build multipart/form-data body manually.
   * This is needed because Node.js FormData behavior differs from browser.
   */
  private buildMultipartBody(
    boundary: string,
    filename: string,
    content: string,
    mimeType: string
  ): string {
    const parts: string[] = [];

    // File part
    parts.push(`--${boundary}`);
    parts.push(`Content-Disposition: form-data; name="files"; filename="${filename}"`);
    parts.push(`Content-Type: ${mimeType}`);
    parts.push('');
    parts.push(content);

    // End boundary
    parts.push(`--${boundary}--`);
    parts.push('');

    return parts.join('\r\n');
  }
}

/**
 * Error class for file upload failures.
 */
export class FileUploadError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = 'FileUploadError';
  }

  /**
   * Get detailed error log.
   */
  getDetailedLog(): string {
    return `FileUploadError: ${this.message}
Status: ${this.statusCode}
Response: ${this.responseBody}`;
  }
}
