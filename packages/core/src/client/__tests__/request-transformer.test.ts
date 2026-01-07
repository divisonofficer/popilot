/**
 * Tests for RequestTransformer
 * Focuses on file attachment extraction logic
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RequestTransformer } from '../request-transformer.js';
import type { Message } from '../../types.js';

describe('RequestTransformer', () => {
  let transformer: RequestTransformer;

  beforeEach(() => {
    transformer = new RequestTransformer({
      maxTextLength: 50000,
      maxToolOutputLength: 1500,
      minFileAttachmentSize: 2000,
      extractFileAttachments: true,
    });
  });

  describe('file attachment extraction', () => {
    it('should extract large file.read results as attachments', () => {
      // Create large file content (> 2000 chars)
      const largeContent = 'x'.repeat(3000);
      const sha256 = 'abc123def456';

      const messages: Message[] = [
        { role: 'user', content: 'Read the file' },
        {
          role: 'assistant',
          content: 'I will read the file for you.',
        },
        {
          role: 'tool',
          content: JSON.stringify({
            type: 'file.read',
            filePath: '/workspace/src/example.ts',
            sha256: sha256,
            totalLines: 100,
            content: largeContent,
          }),
          name: 'file.read',
        },
      ];

      const result = transformer.transform(messages);

      // File attachment should be created
      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('example.ts');
      expect(result.files[0]._pendingContent).toBe(largeContent);
      expect(result.files[0]._pendingMimeType).toBe('text/typescript');

      // Message should reference the SHA256 for future edits
      expect(result.message).toContain(sha256);
      expect(result.message).toContain('FILE UPLOADED');
    });

    it('should NOT create attachment for small files', () => {
      const smallContent = 'console.log("hello")';
      const sha256 = 'abc123def456';

      const messages: Message[] = [
        { role: 'user', content: 'Read the file' },
        {
          role: 'tool',
          content: JSON.stringify({
            type: 'file.read',
            filePath: '/workspace/src/small.ts',
            sha256: sha256,
            totalLines: 1,
            content: smallContent,
          }),
          name: 'file.read',
        },
      ];

      const result = transformer.transform(messages);

      // No file attachments for small files
      expect(result.files).toHaveLength(0);
      // Content should be directly in message (as [Tool Result]: ...)
      // The JSON-stringified content includes the small content
      expect(result.message).toContain('[Tool Result]');
    });

    it('should handle multiple file.read results', () => {
      const content1 = 'first file content'.repeat(200); // > 2000 chars
      const content2 = 'second file content'.repeat(200); // > 2000 chars

      const messages: Message[] = [
        { role: 'user', content: 'Read both files' },
        {
          role: 'tool',
          content: JSON.stringify({
            type: 'file.read',
            filePath: '/workspace/src/file1.ts',
            sha256: 'sha1111',
            content: content1,
          }),
          name: 'file.read',
        },
        {
          role: 'tool',
          content: JSON.stringify({
            type: 'file.read',
            filePath: '/workspace/src/file2.py',
            sha256: 'sha2222',
            content: content2,
          }),
          name: 'file.read',
        },
      ];

      const result = transformer.transform(messages);

      // Both files should be extracted
      expect(result.files).toHaveLength(2);

      // Find files by name (order may vary)
      const file1 = result.files.find(f => f.name === 'file1.ts');
      const file2 = result.files.find(f => f.name === 'file2.py');

      expect(file1).toBeDefined();
      expect(file2).toBeDefined();

      // MIME types should be correct
      expect(file1?._pendingMimeType).toBe('text/typescript');
      expect(file2?._pendingMimeType).toBe('text/x-python');
    });

    it('should disable file extraction when configured', () => {
      const disabledTransformer = new RequestTransformer({
        extractFileAttachments: false,
      });

      const largeContent = 'x'.repeat(3000);
      const messages: Message[] = [
        { role: 'user', content: 'Read the file' },
        {
          role: 'tool',
          content: JSON.stringify({
            type: 'file.read',
            filePath: '/workspace/src/example.ts',
            sha256: 'abc123',
            content: largeContent,
          }),
          name: 'file.read',
        },
      ];

      const result = disabledTransformer.transform(messages);

      // No attachments when disabled
      expect(result.files).toHaveLength(0);
    });

    it('should respect minFileAttachmentSize threshold', () => {
      const customTransformer = new RequestTransformer({
        extractFileAttachments: true,
        minFileAttachmentSize: 5000, // Higher threshold
      });

      const mediumContent = 'x'.repeat(3000); // Less than 5000
      const messages: Message[] = [
        { role: 'user', content: 'Read the file' },
        {
          role: 'tool',
          content: JSON.stringify({
            type: 'file.read',
            filePath: '/workspace/src/medium.ts',
            sha256: 'abc123',
            content: mediumContent,
          }),
          name: 'file.read',
        },
      ];

      const result = customTransformer.transform(messages);

      // No attachment because content < minFileAttachmentSize
      expect(result.files).toHaveLength(0);
    });
  });

  describe('multi-language file handling', () => {
    // MIME types match file-uploader.ts getMimeType()
    const testFileTypes = [
      { ext: 'py', mimeType: 'text/x-python', language: 'Python' },
      { ext: 'cpp', mimeType: 'text/x-c++', language: 'C++' },
      { ext: 'java', mimeType: 'text/x-java', language: 'Java' },
      { ext: 'go', mimeType: 'text/x-go', language: 'Go' },
      { ext: 'rs', mimeType: 'text/x-rust', language: 'Rust' },
      { ext: 'tsx', mimeType: 'text/typescript', language: 'TSX' },
      { ext: 'jsx', mimeType: 'text/javascript', language: 'JSX' },
      { ext: 'json', mimeType: 'application/json', language: 'JSON' },
      { ext: 'md', mimeType: 'text/markdown', language: 'Markdown' },
    ];

    for (const { ext, mimeType, language } of testFileTypes) {
      it(`should handle ${language} files (.${ext})`, () => {
        const content = `// ${language} file content\n`.repeat(200);
        const messages: Message[] = [
          { role: 'user', content: `Read the ${language} file` },
          {
            role: 'tool',
            content: JSON.stringify({
              type: 'file.read',
              filePath: `/workspace/src/example.${ext}`,
              sha256: 'abc123',
              content: content,
            }),
            name: 'file.read',
          },
        ];

        const result = transformer.transform(messages);

        expect(result.files).toHaveLength(1);
        expect(result.files[0].name).toBe(`example.${ext}`);
        expect(result.files[0]._pendingMimeType).toBe(mimeType);
      });
    }
  });

  describe('SHA256 preservation', () => {
    it('should preserve SHA256 in message for file.applyTextEdits', () => {
      const content = 'x'.repeat(3000);
      const sha256 = 'cafebabe12345678deadbeef';

      const messages: Message[] = [
        { role: 'user', content: 'Read and edit the file' },
        {
          role: 'tool',
          content: JSON.stringify({
            type: 'file.read',
            filePath: '/workspace/src/config.ts',
            sha256: sha256,
            content: content,
          }),
          name: 'file.read',
        },
      ];

      const result = transformer.transform(messages);

      // SHA256 must be in the message for future file.applyTextEdits
      expect(result.message).toContain(`SHA256: ${sha256}`);
    });

    it('should include totalLines count', () => {
      const content = 'line\n'.repeat(500);

      const messages: Message[] = [
        { role: 'user', content: 'Read the file' },
        {
          role: 'tool',
          content: JSON.stringify({
            type: 'file.read',
            filePath: '/workspace/src/large.ts',
            sha256: 'abc123',
            totalLines: 500,
            content: content,
          }),
          name: 'file.read',
        },
      ];

      const result = transformer.transform(messages);

      expect(result.message).toContain('Total lines: 500');
    });
  });

  describe('tool output truncation', () => {
    it('should truncate non-file tool outputs that exceed limit', () => {
      const largeOutput = 'terminal output '.repeat(500); // Large output

      const messages: Message[] = [
        { role: 'user', content: 'Run the command' },
        {
          role: 'tool',
          content: largeOutput,
          name: 'run_terminal_command',
        },
      ];

      const result = transformer.transform(messages);

      // Should be truncated
      expect(result.message).toContain('[Note: Output truncated');
      // No file attachments for terminal output
      expect(result.files).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty messages array', () => {
      const result = transformer.transform([]);

      expect(result.message).toBeDefined();
      expect(result.files).toHaveLength(0);
    });

    it('should handle messages without tool results', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const result = transformer.transform(messages);

      expect(result.files).toHaveLength(0);
    });

    it('should handle malformed file.read JSON gracefully', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Read the file' },
        {
          role: 'tool',
          content: 'not valid json at all',
          name: 'file.read',
        },
      ];

      // Should not throw
      const result = transformer.transform(messages);
      expect(result.message).toBeDefined();
    });

    it('should handle file.read without sha256', () => {
      const content = 'x'.repeat(3000);

      const messages: Message[] = [
        { role: 'user', content: 'Read the file' },
        {
          role: 'tool',
          content: JSON.stringify({
            type: 'file.read',
            filePath: '/workspace/src/example.ts',
            // No sha256 provided
            content: content,
          }),
          name: 'file.read',
        },
      ];

      const result = transformer.transform(messages);

      // Should handle gracefully (may or may not extract based on implementation)
      expect(result.message).toBeDefined();
    });
  });
});
