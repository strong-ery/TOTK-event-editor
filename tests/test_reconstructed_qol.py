import tempfile
import unittest
from pathlib import Path
import struct

from evfl import Event, EventFlow, Flowchart
from evfl.entry_point import EntryPoint
from evfl.event import SubFlowEvent

from eventeditor.__main__ import (
    APP_DISPLAY_NAME,
    GITHUB_REPOSITORY_SLUG,
    GITHUB_REPOSITORY_URL,
    build_about_html,
    choose_mals_archive_from_directory,
    current_mals_display_name,
    find_eventflow_file_in_directory,
    find_filename_flow_name_mismatch,
    find_missing_internal_subflow_calls,
    flow_filename_name_for_path,
    infer_eventflow_mals_dir,
    infer_eventflow_owner_root,
    infer_mals_archive_for_flow_path,
    is_vanilla_romfs_path,
    MALS_MODE_INFERRED,
    MALS_MODE_MANUAL,
    normalize_display_version,
    normalize_flow_save_path,
)
import eventeditor.actor_xml as actor_xml
import eventeditor.container_xml as container_xml
import eventeditor.entry_point_tree_xml as entry_point_tree_xml
import eventeditor._version as versioneer_runtime_config
import eventeditor.mals as mals
import eventeditor.totk_zs as totk_zs
import eventeditor.util as util


class ReconstructedQoLTests(unittest.TestCase):
    def test_public_identity_strings(self):
        self.assertEqual(APP_DISPLAY_NAME, 'TOTK EventEditor')
        self.assertEqual(GITHUB_REPOSITORY_SLUG, 'cargocult-mods/TOTK-event-editor')
        self.assertEqual(GITHUB_REPOSITORY_URL, 'https://github.com/cargocult-mods/TOTK-event-editor')
        self.assertEqual(versioneer_runtime_config.get_config().tag_prefix, 'v')

        about_html = build_about_html('v1.0.0')
        self.assertIn(APP_DISPLAY_NAME, about_html)
        self.assertIn(GITHUB_REPOSITORY_SLUG, about_html)
        self.assertIn(GITHUB_REPOSITORY_URL, about_html)
        self.assertIn('Version: v1.0.0', about_html)
        self.assertNotIn('Revision:', about_html)

    def test_placeholder_versions_are_not_displayed(self):
        self.assertEqual(normalize_display_version('0+unknown'), 'development build')
        self.assertEqual(normalize_display_version('0+unknown.d20260607'), 'development build')
        self.assertEqual(normalize_display_version(None), 'development build')
        self.assertEqual(normalize_display_version('v1.0.0'), 'v1.0.0')

    def test_totk_suffix_helpers(self):
        self.assertEqual(
            normalize_flow_save_path('Demo', 'Compressed TotK flowchart .bfevfl.zs (*)'),
            'Demo.bfevfl.zs',
        )
        self.assertEqual(flow_filename_name_for_path('Demo.bfevfl.zs'), 'Demo')
        self.assertEqual(flow_filename_name_for_path('Demo.evfl.zs'), 'Demo')
        self.assertTrue(totk_zs.is_compressed_path('Demo.bfevfl.zs'))
        self.assertTrue(totk_zs.is_compressed_path('Demo.bfevfl.zstd'))
        self.assertFalse(totk_zs.is_compressed_path('Demo.bfevfl'))

    def test_save_flow_name_match_helpers(self):
        flow = EventFlow()
        flow.name = 'DemoFlow'
        flow.flowchart = Flowchart()
        flow.flowchart.name = 'DemoFlow'

        self.assertIsNone(find_filename_flow_name_mismatch('DemoFlow.bfevfl.zs', flow))
        self.assertEqual(
            find_filename_flow_name_mismatch('OtherName.bfevfl.zs', flow),
            ('OtherName', ['DemoFlow']),
        )

    def test_missing_internal_subflow_helper(self):
        flow = EventFlow()
        flow.name = 'DemoFlow'
        flow.flowchart = Flowchart()
        flow.flowchart.name = 'DemoFlow'

        entry_point = EntryPoint('Talk')
        flow.flowchart.entry_points = [entry_point]

        valid = Event()
        valid.name = 'EventValid'
        valid.data = SubFlowEvent()
        valid.data.entry_point_name = 'Talk'

        missing = Event()
        missing.name = 'EventMissing'
        missing.data = SubFlowEvent()
        missing.data.entry_point_name = 'Missing'

        external = Event()
        external.name = 'EventExternal'
        external.data = SubFlowEvent()
        external.data.res_flowchart_name = 'ExternalFlow'
        external.data.entry_point_name = 'Missing'

        flow.flowchart.events = [valid, missing, external]
        self.assertEqual(
            find_missing_internal_subflow_calls(flow),
            ['EventMissing calls DemoFlow<Missing>'],
        )

    def test_mals_inference_helpers_for_romfs_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'TestMod'
            flow_dir = root / 'romfs' / 'Event' / 'EventFlow'
            mals_dir = root / 'romfs' / 'Mals'
            flow_dir.mkdir(parents=True)
            mals_dir.mkdir(parents=True)
            flow_path = flow_dir / 'Demo.bfevfl.zs'
            preferred = mals_dir / 'USen.Product.110.sarc.zs'
            fallback = mals_dir / 'ZZ.sarc.zs'
            flow_path.write_bytes(b'')
            preferred.write_bytes(b'')
            fallback.write_bytes(b'')

            self.assertEqual(infer_eventflow_owner_root(str(flow_path)), root)
            self.assertEqual(infer_eventflow_mals_dir(str(flow_path)), mals_dir)
            self.assertEqual(choose_mals_archive_from_directory(mals_dir), str(preferred))
            self.assertEqual(infer_mals_archive_for_flow_path(str(flow_path)), str(preferred))

    def test_mals_inference_helpers_for_loose_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'LooseMod'
            flow_dir = root / 'Event' / 'EventFlow'
            mals_dir = root / 'Mals'
            flow_dir.mkdir(parents=True)
            mals_dir.mkdir(parents=True)
            flow_path = flow_dir / 'Demo.bfevfl.zs'
            mals_path = mals_dir / 'USen.Product.110.sarc.zs'
            flow_path.write_bytes(b'')
            mals_path.write_bytes(b'')

            self.assertEqual(infer_eventflow_owner_root(str(flow_path)), root)
            self.assertEqual(infer_eventflow_mals_dir(str(flow_path)), mals_dir)
            self.assertEqual(infer_mals_archive_for_flow_path(str(flow_path)), str(mals_path))

    def test_mals_current_display_uses_vanilla_romfs(self):
        old_romfs_path = totk_zs.get_romfs_path()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                romfs = Path(tmp) / 'romfs'
                mals_dir = romfs / 'Mals'
                mals_dir.mkdir(parents=True)
                mals_path = mals_dir / 'USen.Product.110.sarc.zs'
                mals_path.write_bytes(b'')
                totk_zs.set_romfs_path(str(romfs))

                self.assertEqual(
                    current_mals_display_name(MALS_MODE_INFERRED, str(mals_path), '', ''),
                    'Vanilla',
                )
        finally:
            totk_zs.set_romfs_path(str(old_romfs_path) if old_romfs_path else None)

    def test_mals_current_display_uses_manual_label_for_manual_mode(self):
        self.assertEqual(
            current_mals_display_name(
                MALS_MODE_MANUAL,
                r'C:\Mods\Example\romfs\Mals\USen.Product.110.sarc.zs',
                '',
                r'C:\Mods\Example\romfs\Mals\USen.Product.110.sarc.zs',
            ),
            'Manual',
        )

    def test_find_eventflow_file_in_directory_prefers_totk_suffix(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            preferred = root / 'ExternalFlow.bfevfl.zs'
            fallback = root / 'ExternalFlow.evfl.zs'
            preferred.write_bytes(b'')
            fallback.write_bytes(b'')

            self.assertEqual(
                find_eventflow_file_in_directory(root, 'ExternalFlow'),
                str(preferred),
            )
            self.assertEqual(
                find_eventflow_file_in_directory(root, 'ExternalFlow.bfevfl.zs'),
                str(preferred),
            )

    def test_vanilla_romfs_path_helper(self):
        old_romfs_path = totk_zs.get_romfs_path()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                romfs = Path(tmp) / 'romfs'
                flow_path = romfs / 'Event' / 'EventFlow' / 'Demo.bfevfl.zs'
                mod_path = Path(tmp) / 'Mod' / 'Event' / 'EventFlow' / 'Demo.bfevfl.zs'
                flow_path.parent.mkdir(parents=True)
                mod_path.parent.mkdir(parents=True)
                flow_path.write_bytes(b'')
                mod_path.write_bytes(b'')
                totk_zs.set_romfs_path(str(romfs))

                self.assertTrue(is_vanilla_romfs_path(str(flow_path)))
                self.assertFalse(is_vanilla_romfs_path(str(mod_path)))
        finally:
            totk_zs.set_romfs_path(str(old_romfs_path) if old_romfs_path else None)

    def test_container_xml_roundtrip(self):
        payload = {
            'BoolValue': True,
            'IntValue': 7,
            'FloatValue': 1.25,
            'StringValue': 'Message/Event_001',
        }
        self.assertEqual(
            container_xml.loads_container_dict(container_xml.dumps_container_dict(payload)),
            payload,
        )

    def test_actor_xml_roundtrip(self):
        payload = [
            {
                'name': 'Npc_Test',
                'sub_name': '',
                'argument_name': '',
                'argument_entry_point': None,
                'concurrent_clips': 65535,
                'actions': ['Talk'],
                'queries': ['IsOnInstEventFlag'],
                'params': {'MessageId': 'EventFlowMsg/Npc_Test:Talk_001'},
            }
        ]
        self.assertEqual(actor_xml.loads_actors(actor_xml.dumps_actors(payload)), payload)

    def test_entry_point_tree_xml_roundtrip(self):
        payload = {
            'version': 2,
            'events': [
                {
                    'source_idx': 0,
                    'kind': 'sub_flow',
                    'params': None,
                    'entry_point_name': 'Entry0',
                    'res_flowchart_name': '',
                }
            ],
            'actors': [],
            'entry_points': [
                {
                    'name': 'Entry0',
                    'items': {},
                    'main_event_idx': 0,
                    'main_event_name': 'Event0',
                }
            ],
        }
        expected = {
            'version': 2,
            'events': [
                {
                    'source_idx': 0,
                    'kind': 'sub_flow',
                    'entry_point_name': 'Entry0',
                    'res_flowchart_name': '',
                }
            ],
            'actors': [],
            'entry_points': [
                {
                    'name': 'Entry0',
                    'items': {},
                    'main_event_idx': 0,
                    'main_event_name': 'Event0',
                }
            ],
        }
        self.assertEqual(
            entry_point_tree_xml.loads_payload(entry_point_tree_xml.dumps_payload(payload)),
            expected,
        )

    def test_mals_prefix_matching(self):
        message_ids = {
            'EventFlowMsg/Npc_Test:Talk_001',
            'EventFlowMsg/Npc_Test:Talk_002',
            'EventFlowMsg/Another_Test:Talk_001',
            'MalformedMessageId',
        }
        grouped = mals._group_message_ids_by_prefix(message_ids)
        self.assertEqual(grouped['EventFlowMsg/Npc_Test'], {'Talk_001', 'Talk_002'})
        self.assertEqual(grouped['EventFlowMsg/Another_Test'], {'Talk_001'})
        self.assertEqual(
            mals._matching_prefixes(
                'EventFlowMsg/Npc_Test.msbt',
                ['EventFlowMsg/Npc_Test', 'Npc_Test', 'Missing'],
            ),
            ['EventFlowMsg/Npc_Test', 'Npc_Test'],
        )

    def test_mals_lbl1_empty_terminal_group(self):
        label = b'talk_000_help01'
        group_count = 2
        table_end = 4 + group_count * 8
        section = bytearray()
        section += struct.pack('<I', group_count)
        section += struct.pack('<II', 1, table_end)
        section += struct.pack('<II', 0, table_end + 1 + len(label) + 4)
        section += bytes([len(label)])
        section += label
        section += struct.pack('<I', 41)

        self.assertEqual(
            mals._parse_lbl1(bytes(section), '<'),
            {41: 'talk_000_help01'},
        )

    def test_packaged_assets_resolve(self):
        for asset in [
            'assets/main.js',
            'assets/main.css',
            'assets/index.html',
            'assets/material_visibility_24.svg',
            'assets/material_visibility_off_24.svg',
        ]:
            self.assertTrue(Path(util.get_path(asset)).is_file(), asset)

    def test_graph_ui_labels_and_hooks(self):
        source_root = Path(__file__).resolve().parents[1] / 'eventeditor'
        main_js = Path(util.get_path('assets/main.js')).read_text(encoding='utf-8')
        main_py = (source_root / '__main__.py').read_text(encoding='utf-8')
        flowchart_py = (source_root / 'flowchart_view.py').read_text(encoding='utf-8')

        self.assertIn("('Text', 'mals')", flowchart_py)
        self.assertNotIn('Mals text', flowchart_py)
        self.assertIn("QAction('Open Mals'", main_py)
        self.assertNotIn('Open Current Mals', main_py)
        self.assertNotIn("QAction('Show &tags'", main_py)
        self.assertNotIn("'Include text tags'", main_py)
        self.assertNotIn("include_text_tags", main_py)
        self.assertNotIn("'Render MSBT tags as styling'", main_py)
        self.assertIn("'Turn style tags into formatting'", main_py)
        self.assertNotIn("'Show non-text tags'", main_py)
        self.assertIn("'Hide non-formatting tags'", main_py)
        self.assertIn("hide_non_formatting_tags", main_py)
        self.assertNotIn("'Include blank lines'", main_py)
        self.assertIn("'Hide blank lines'", main_py)
        self.assertIn("hide_blank_lines", main_py)
        self.assertIn("'Show text bubble breaks'", main_py)
        self.assertIn("show_text_bubble_breaks", main_py)
        self.assertIn("widget.goToSubflowEntryPoint(idx)", main_js)
        self.assertIn(r"ChoiceLabel\d+", main_js)
        self.assertIn("'0': '#ff6634'", main_js)
        self.assertIn("const currentStyle = {};", main_js)
        self.assertIn("hasSvgTextStyle(currentStyle)", main_js)
        self.assertIn(".split('\\n')", main_js)
        self.assertIn("const WRAP_TOKEN_REGEX", main_js)
        self.assertIn("const MESSAGE_BLANK_LINE = '\\u00A0'", main_js)
        self.assertIn("const MESSAGE_BUBBLE_BREAK_LINE = '\\u2063'", main_js)
        self.assertIn("wrappedLines.push(MESSAGE_BLANK_LINE)", main_js)
        self.assertIn("isMessagePageBreakTagToken(token)", main_js)
        self.assertIn("function applyTextBubbleBreaks", main_js)
        self.assertNotIn("bubbleLineCount", main_js)
        self.assertIn("const MESSAGE_BUBBLE_SOURCE_LINE_LIMIT = 3", main_js)
        self.assertIn("let sourceTextLineCount = 0", main_js)
        self.assertIn("if (showMessageBubbleBreaks && !inBlankLineGroup && sourceTextLineCount > 0)", main_js)
        self.assertIn("pushMessageBubbleBreak(lines)", main_js)
        self.assertIn("function appendMessageIdBlock", main_js)
        self.assertIn("appendWrappedLabelLineWithIndent(nextLabel, '  MSBT: '", main_js)
        self.assertIn("appendWrappedLabelLineWithIndent(nextLabel, '  ID:   '", main_js)
        self.assertIn("key === 'MessageId'", main_js)
        self.assertIn("function getNodeLayoutLabel", main_js)
        self.assertIn("label: getNodeLayoutLabel(rawLabel)", main_js)
        self.assertIn("rawLabel,", main_js)
        self.assertIn("this._restoreRawNodeLabels(visibleGraph)", main_js)
        self.assertIn("this._fitNodeBoxesToLabels()", main_js)
        self.assertIn("shape.setAttribute('width'", main_js)
        self.assertNotIn("const render = dagreD3.render()", main_js)
        self.assertIn("const dagreRenderer = dagreD3.render()", main_js)
        self.assertIn("closestNodeIdToViewportCenter", main_js)
        self.assertIn("preservedFocusPoint = preservedFocusNodeId == null ? null : graph.renderer.viewportCenterPoint()", main_js)
        self.assertIn(r"\{\{[^{}\n]+\}\}|[ \t]+|[^\s{}]+", main_js)
        self.assertIn("messageTokenVisibleText(token)", main_js)
        self.assertIn("let showNonTextMessageTags = true", main_js)
        self.assertIn("let includeMessageBlankLines = true", main_js)
        self.assertIn("let showMessageBubbleBreaks = true", main_js)
        self.assertIn("lines.push(MESSAGE_BLANK_LINE)", main_js)
        self.assertIn("sourceTextLineCount >= MESSAGE_BUBBLE_SOURCE_LINE_LIMIT", main_js)
        self.assertIn("window.eventEditorSetShowNonTextMessageTags", main_js)
        self.assertIn("window.eventEditorSetIncludeMessageBlankLines", main_js)
        self.assertIn("window.eventEditorSetShowMessageBubbleBreaks", main_js)
        self.assertIn("!showNonTextMessageTags && !isMessageFormatTag(tag)", main_js)
        self.assertIn("setNonTextMessageTagsVisible", flowchart_py)
        self.assertIn("onHideNonFormattingMalsTagsChanged", main_py)
        self.assertIn("eventTagVisibilityChanged.emit(self._include_mals_text_tags)", main_py)
        self.assertIn("setMessageBlankLinesIncluded", flowchart_py)
        self.assertIn("onHideMalsBlankLinesChanged", main_py)
        self.assertIn("setMessageBubbleBreaksShown", flowchart_py)
        self.assertIn("menu.addAction('Edit', lambda checked=False: self.doubleClicked.emit())", flowchart_py)
        self.assertIn("menu.addAction('Show only selected', self.showOnlySelectedEntryPoints)", flowchart_py)
        self.assertIn("menu.addAction('Show All', lambda checked=False: self.webShowAllEvents())", flowchart_py)
        self.assertIn("def showOnlySelectedEntryPoints", flowchart_py)
        self.assertIn("self.flow_data.entry_point_model.isHiddenRow(source_row)", flowchart_py)
        self.assertIn("self.flow_data.entry_point_model.setRowsHidden([source_row], False)", flowchart_py)
        self.assertIn("self.web_object.preserveViewportRequested.emit()", flowchart_py)
        self.assertIn("self._launchNewInstanceForPath(path, entry_point_name=entry_point_name)", main_py)
        self.assertIn("parser.add_argument('--entry-point'", main_py)
        self.assertIn("self.selectStartupEntryPointIfRequested()", main_py)

    def test_plain_and_gzip_flow_roundtrip(self):
        flow = EventFlow()
        flow.name = 'SmokeFlow'
        flow.flowchart = Flowchart()
        flow.flowchart.name = 'SmokeFlow'

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            for suffix in ['.bfevfl', '.bfevfl.gz']:
                path = tmp_dir / f'SmokeFlow{suffix}'
                util.write_flow(str(path), flow)
                loaded = EventFlow()
                util.read_flow(str(path), loaded)
                self.assertEqual(loaded.name, 'SmokeFlow')


if __name__ == '__main__':
    unittest.main()
