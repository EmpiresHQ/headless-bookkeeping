"""Independent XML/semicolon CSV checks against deterministic SYNTHETIC fixtures."""
import csv, hashlib, json, pathlib, xml.etree.ElementTree as ET
root = pathlib.Path(__file__).parent
fixtures = json.loads((root / 'fixtures.json').read_text())
rows = []
for width, f in zip((320, 390), fixtures['periods']):
    expected_vat = f"{f['vatCents']/100:.2f}"
    expected_gross = f"{f['grossCents']/100:.2f}"
    number = f"SYNTHETIC301-{f['name']}-INV-001"
    for file in sorted(root.glob(f'{width}-*.xml')):
        data = file.read_bytes()
        node = ET.fromstring(data)
        assert node.tag == 'vatDeclaration'
        assert node.findtext('taxPayerRegCode') == '17499653'
        assert node.findtext('year') == '2026'
        assert int(node.findtext('month')) == int(f['name'][-2:])
        assert node.findtext('.//inputVatTotal') == expected_vat
        assert node.findtext('.//invoiceNumber') == number
        assert node.findtext('.//invoiceSumVat') == expected_gross
        assert node.findtext('.//sellerName') == 'SYNTHETIC 301 Supplier OÜ'
        rows.append({'file': file.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'wellFormedXml': True, 'fixtureValuesMatch': True})
    assert (root/f'{width}-frozen.xml').read_bytes() == (root/f'{width}-frozen-repeat.xml').read_bytes()
    for file in sorted(root.glob(f'{width}-*.csv')):
        data = file.read_bytes()
        records = list(csv.reader(data.decode('utf8').splitlines(), delimiter=';'))
        assert data.count(b'\r\n') == 1 and b'\\r\\n' not in data
        assert len(records) == 2
        assert records[0][0] == 'KMD6' and records[0][-1] == expected_vat
        assert records[1][0] == 'B' and records[1][2] == 'SYNTHETIC 301 Supplier OÜ'
        assert records[1][3] == number and records[1][5] == expected_gross and records[1][-1] == expected_vat
        rows.append({'file': file.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'records': len(records), 'recordWidths': [len(r) for r in records], 'realCrlf': True, 'fixtureValuesMatch': True})
(root/'file-checks.json').write_text(json.dumps(rows, indent=2)+'\n')
print(f'{len(rows)} downloaded artifacts verified; frozen repeats identical')
