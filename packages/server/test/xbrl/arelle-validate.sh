#!/usr/bin/env bash
# Validate one generated annual-accounts XBRL instance with Arelle, the
# reference XBRL 2.1 processor, against the OFFICIAL et-gaap taxonomy.
#
# The Jest suite (`validate-xbrl-instance.ts`) runs on every commit and drives
# its rules from the same official core schema. This script is the heavier
# out-of-band check: a full conformance pass by an independent processor,
# including the calculation linkbase, which is what fixed the expense-sign
# question in issue #204.
#
# Fully offline and version-pinned once the cache is seeded: the taxonomy files
# come from the pinned zip / core schema recorded in
# `test/fixtures/xbrl/PROVENANCE.md`, and Arelle is installed at a pinned
# release into a throwaway venv.
#
#   ./test/xbrl/arelle-validate.sh <instance.xbrl> [more.xbrl ...]
#
# Exits nonzero if Arelle reports any error or inconsistency.
set -euo pipefail

ARELLE_VERSION="${ARELLE_VERSION:-2.45.1}"
WORK="${ARELLE_WORK:-${TMPDIR:-/tmp}/et-gaap-arelle}"
VENV="$WORK/venv"
HOME_DIR="$WORK/home"
CACHE="$HOME_DIR/arelle/cache/http/xbrl.eesti.ee/taxonomy"

TAXONOMY_ZIP_URL="http://xbrl.eesti.ee/wp-content/uploads/2026/02/et-gaap_2026-01-01.zip"
TAXONOMY_ZIP_SHA256="52a715e2d41fa1a701d961b89aab52512e90c56f4b57cfe170e759d737956aaa"
CORE_XSD_URL="http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/et-gaap-cor_2026-01-01.xsd"
CORE_XSD_SHA256="8810b65881d7d788de5b33c70ad71c2fb66638991d98a598f48eff3fd3e0f32f"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDORED_CORE="$here/../fixtures/xbrl/et-gaap_2026-01-01/et-gaap-cor_2026-01-01.xsd"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <instance.xbrl> [more.xbrl ...]" >&2
  exit 2
fi

mkdir -p "$WORK" "$CACHE/et-gaap_2026-01-01"

if [ ! -x "$VENV/bin/arelleCmdLine" ]; then
  echo "==> installing arelle-release==$ARELLE_VERSION into $VENV (network)"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet "arelle-release==$ARELLE_VERSION"
fi

# The core schema comes from the repo, so the pinned bytes the Jest suite
# validates against are the bytes Arelle resolves too.
echo "$CORE_XSD_SHA256  $VENDORED_CORE" | sha256sum --check --quiet
cp "$VENDORED_CORE" "$CACHE/et-gaap_2026-01-01/"

# The linkbases are not vendored (see PROVENANCE.md); fetch the pinned zip once.
if [ ! -d "$CACHE/et-gaap_2026-01-01/role-201000" ]; then
  echo "==> fetching pinned taxonomy linkbases (network)"
  curl -sSLo "$WORK/et-gaap.zip" "$TAXONOMY_ZIP_URL"
  echo "$TAXONOMY_ZIP_SHA256  $WORK/et-gaap.zip" | sha256sum --check --quiet
  unzip -q -o "$WORK/et-gaap.zip" -d "$WORK/unzipped"
  cp -r "$WORK/unzipped/et-gaap_2026-01-01/." "$CACHE/et-gaap_2026-01-01/"
  # Linkbase locators say `../../et-gaap-cor_2026-01-01.xsd`, i.e. one level
  # above the version directory; RIK serves the schema inside it. Place a copy
  # where the shipped relative hrefs resolve.
  cp "$VENDORED_CORE" "$CACHE/"
fi

# An entry point that pulls in the väikeettevõtja balance sheet [201012] and
# income statement scheme 1 [301011] calculation linkbases — the two forms this
# renderer targets. It adds no concepts; every declaration stays RIK's.
cat > "$WORK/entry.xsd" <<'XSD'
<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema targetNamespace="urn:headless-bookkeeping:et-gaap-calc-entry"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:link="http://www.xbrl.org/2003/linkbase"
  xmlns:xlink="http://www.w3.org/1999/xlink">
  <xsd:annotation><xsd:appinfo>
    <link:linkbaseRef xlink:type="simple"
      xlink:arcrole="http://www.w3.org/1999/xlink/properties/linkbase"
      xlink:href="http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/role-201000/cal_StatementOfFinancialPosition_role-201012.xml"/>
    <link:linkbaseRef xlink:type="simple"
      xlink:arcrole="http://www.w3.org/1999/xlink/properties/linkbase"
      xlink:href="http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/role-301000/cal_IncomeStatementScheme1_role-301011.xml"/>
  </xsd:appinfo></xsd:annotation>
  <xsd:import namespace="http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/"
    schemaLocation="http://xbrl.eesti.ee/taxonomy/et-gaap-cor_2026-01-01.xsd"/>
</xsd:schema>
XSD

status=0

# Two independent gates, because neither alone is sound: arelleCmdLine exits 0
# even when it logs validation errors, and a run that dies (OOM, timeout, a
# crash before it logs anything) exits nonzero with an empty log. Fail on
# either a nonzero exit or a log line that is not an [info] line.
ARELLE_TIMEOUT="${ARELLE_TIMEOUT:-300}"

run_arelle() {
  local log="$1"; shift
  local rc=0
  LC_ALL=C timeout "$ARELLE_TIMEOUT" "$VENV/bin/arelleCmdLine" "$@" --validate \
    --internetConnectivity offline --xdgConfigHome "$HOME_DIR" \
    --logLevel warning > "$log" 2>&1 || rc=$?
  cat "$log"
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ]; then
      echo "!! arelle timed out after ${ARELLE_TIMEOUT}s" >&2
    else
      echo "!! arelle exited $rc" >&2
    fi
    return 1
  fi
  if grep -qv '^\[info' "$log"; then
    return 1
  fi
  return 0
}

for instance in "$@"; do
  echo "==> $instance"

  # Pass 1: the instance exactly as generated, against its own schemaRef.
  run_arelle "$WORK/pass1.log" --file "$instance" || status=1

  # Pass 2: the same facts with the calculation linkbases loaded, so
  # calculation consistency is checked too.
  calc="$WORK/$(basename "$instance").calc.xbrl"
  sed "s|xlink:href=\"$CORE_XSD_URL\"|xlink:href=\"$WORK/entry.xsd\"|" \
    "$instance" > "$calc"
  run_arelle "$WORK/pass2.log" --file "$calc" --calcDecimals || status=1
done

if [ "$status" -eq 0 ]; then
  echo "==> Arelle reported no errors or inconsistencies"
fi
exit "$status"
