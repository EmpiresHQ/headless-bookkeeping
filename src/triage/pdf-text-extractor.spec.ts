import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { PdfTextExtractor } from './pdf-text-extractor';

// The extractor is a thin wrapper: call pdf-parse, trim, swallow errors → ''.
// We unit-test THAT logic with pdf-parse mocked; real pdf-parse parsing is its
// own (trusted) concern and was verified out-of-band against a real PDF.
jest.mock('pdf-parse/lib/pdf-parse.js');
const mockParse = pdfParse as jest.MockedFunction<typeof pdfParse>;

describe('PdfTextExtractor', () => {
  afterEach(() => jest.resetAllMocks());

  it('returns the trimmed extracted text on success', async () => {
    mockParse.mockResolvedValue({ text: '  # Invoice\nAcme Ltd  \n', numpages: 1 });
    const text = await new PdfTextExtractor().extract(Buffer.from('%PDF'));
    expect(text).toBe('# Invoice\nAcme Ltd');
    expect(mockParse).toHaveBeenCalledTimes(1);
  });

  it('returns empty string when extraction throws (corrupt / no text layer)', async () => {
    mockParse.mockRejectedValue(new Error('bad XRef entry'));
    const text = await new PdfTextExtractor().extract(Buffer.from('not a pdf'));
    expect(text).toBe('');
  });
});
