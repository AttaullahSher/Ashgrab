/* Builds the Ashgrab shortcut as an Apple property list: URL-encode whatever
   was shared, then open Ashgrab with it, registered for the Share Sheet.

   The output is UNSIGNED, and iOS refuses to import unsigned shortcut files —
   so this is only half the job. .github/workflows/sign-shortcut.yml runs this
   on a macOS runner, signs the result with `shortcuts sign --mode anyone`,
   and commits the signed file to assets/Ashgrab.shortcut, which is what the
   "Add the Ashgrab shortcut" button on the site links to. */

import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const SITE = 'https://attaullahsher.github.io/Ashgrab/';
const OBJ = '￼'; // object-replacement character: where the variable goes
const out = process.argv[2] || 'Ashgrab-unsigned.shortcut';

const uuid = randomUUID().toUpperCase();
const target = SITE + '?url=' + OBJ;
const index = target.indexOf(OBJ);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>WFWorkflowClientVersion</key>
\t<string>2038.1.1</string>
\t<key>WFWorkflowMinimumClientVersion</key>
\t<integer>900</integer>
\t<key>WFWorkflowMinimumClientVersionString</key>
\t<string>900</string>
\t<key>WFWorkflowHasShortcutInputVariables</key>
\t<true/>
\t<key>WFWorkflowIcon</key>
\t<dict>
\t\t<key>WFWorkflowIconGlyphNumber</key>
\t\t<integer>59511</integer>
\t\t<key>WFWorkflowIconStartColor</key>
\t\t<integer>946986751</integer>
\t</dict>
\t<key>WFWorkflowImportQuestions</key>
\t<array/>
\t<key>WFWorkflowTypes</key>
\t<array>
\t\t<string>ActionExtension</string>
\t</array>
\t<key>WFWorkflowInputContentItemClasses</key>
\t<array>
\t\t<string>WFURLContentItem</string>
\t\t<string>WFStringContentItem</string>
\t\t<string>WFRichTextContentItem</string>
\t\t<string>WFSafariWebPageContentItem</string>
\t</array>
\t<key>WFWorkflowActions</key>
\t<array>
\t\t<dict>
\t\t\t<key>WFWorkflowActionIdentifier</key>
\t\t\t<string>is.workflow.actions.urlencode</string>
\t\t\t<key>WFWorkflowActionParameters</key>
\t\t\t<dict>
\t\t\t\t<key>UUID</key>
\t\t\t\t<string>${uuid}</string>
\t\t\t\t<key>WFEncodeMode</key>
\t\t\t\t<string>Encode</string>
\t\t\t\t<key>WFInput</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Value</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>attachmentsByRange</key>
\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t<key>{0, 1}</key>
\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t<key>Type</key>
\t\t\t\t\t\t\t\t<string>ExtensionInput</string>
\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t</dict>
\t\t\t\t\t\t<key>string</key>
\t\t\t\t\t\t<string>${OBJ}</string>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t<string>WFTextTokenString</string>
\t\t\t\t</dict>
\t\t\t</dict>
\t\t</dict>
\t\t<dict>
\t\t\t<key>WFWorkflowActionIdentifier</key>
\t\t\t<string>is.workflow.actions.openurl</string>
\t\t\t<key>WFWorkflowActionParameters</key>
\t\t\t<dict>
\t\t\t\t<key>Show-WFInput</key>
\t\t\t\t<true/>
\t\t\t\t<key>WFInput</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Value</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>attachmentsByRange</key>
\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t<key>{${index}, 1}</key>
\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t<key>OutputName</key>
\t\t\t\t\t\t\t\t<string>URL Encoded Text</string>
\t\t\t\t\t\t\t\t<key>OutputUUID</key>
\t\t\t\t\t\t\t\t<string>${uuid}</string>
\t\t\t\t\t\t\t\t<key>Type</key>
\t\t\t\t\t\t\t\t<string>ActionOutput</string>
\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t</dict>
\t\t\t\t\t\t<key>string</key>
\t\t\t\t\t\t<string>${esc(target)}</string>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t<string>WFTextTokenString</string>
\t\t\t\t</dict>
\t\t\t</dict>
\t\t</dict>
\t</array>
</dict>
</plist>
`;

writeFileSync(out, plist);
console.log(`wrote ${out}`);
console.log(`opens: ${target.replace(OBJ, '<shared link>')}`);
