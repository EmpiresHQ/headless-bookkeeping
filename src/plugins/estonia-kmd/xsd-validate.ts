// Pinned EMTA schema: vatdeclaration.xsd, version family KMD6 (valid from 2025-07-01).
// Source: https://www.emta.ee/en/business-client/e-services-training-courses/how-use-e-services/technical-information-services
import * as libxml from 'libxmljs2';

export function validateAgainstKmdXsd(
  xml: string,
  xsd: string,
): { valid: boolean; errors: string[] } {
  const xsdDoc = libxml.parseXml(xsd);
  const xmlDoc = libxml.parseXml(xml);
  const valid = xmlDoc.validate(xsdDoc);
  return { valid, errors: (xmlDoc.validationErrors ?? []).map((e) => String(e)) };
}
