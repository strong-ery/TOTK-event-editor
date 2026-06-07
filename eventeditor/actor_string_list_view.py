import typing

import eventeditor.ai as ai
import eventeditor.actor_json as aj
from eventeditor.flow_data import FlowDataChangeReason
import eventeditor.util as util
from eventeditor.search_bar import SearchBar
from evfl import EventFlow, Actor
from evfl.common import StringHolder
import PyQt5.QtCore as qc # type: ignore
import PyQt5.QtWidgets as q # type: ignore

class ActorStringListView(q.QWidget):
    def __init__(self, parent, label_str: str, model, flow_data) -> None:
        super().__init__(parent)
        self.flow_data = flow_data
        self.action_builders = [] # type: ignore
        self.model = model
        self.label_str = label_str

        self.lview = q.QListView()
        self.lview.setModel(self.model)
        self.lview.setSelectionMode(q.QAbstractItemView.ExtendedSelection)
        self.lview.setContextMenuPolicy(qc.Qt.CustomContextMenu)
        self.lview.customContextMenuRequested.connect(self.onContextMenu)

        self.add_btn = q.QPushButton('Add...')
        self.add_btn.setStyleSheet('padding: 2px 5px;')
        self.add_btn.clicked.connect(self.onAdd)
        self.header_box = q.QHBoxLayout()
        label = q.QLabel(label_str)
        label.setStyleSheet('font-weight: bold;')
        self.header_box.addWidget(label, stretch=1)
        self.copy_btn = self.addHeaderButton('Copy', self.copyItems)
        self.paste_btn = self.addHeaderButton('Paste', self.pasteItems)
        self.import_btn = self.addHeaderButton('Import...', self.importItems)
        self.export_btn = self.addHeaderButton('Export...', self.exportItems)
        self.header_box.addWidget(self.add_btn)

        layout = q.QVBoxLayout(self)
        layout.addLayout(self.header_box)
        layout.addWidget(self.lview, stretch=1)

    def addHeaderButton(self, text: str, callback) -> q.QPushButton:
        button = q.QPushButton(text)
        button.setStyleSheet('padding: 2px 5px;')
        button.clicked.connect(callback)
        self.header_box.addWidget(button)
        return button

    def onAdd(self) -> None:
        text = self._getNewString()
        if not text:
            return

        if self.model.has(text):
            q.QMessageBox.critical(self, 'Cannot add', 'This action or query already exists.')
            return

        self.model.append(text)
        self.flow_data.actor_model.refresh()

    def _getNewString(self) -> str:
        text, ok = q.QInputDialog.getText(self, f'{self.label_str}', f'Name of the new action or query:', q.QLineEdit.Normal)
        return text

    def onRemove(self, idx) -> None:
        value = idx.data(qc.Qt.UserRole)
        if util.is_actor_string_in_use(self.flow_data.flow.flowchart.events, value):
            q.QMessageBox.critical(self, 'Cannot delete', 'This action or query cannot be deleted because it is in use. Please remove any references to this action or query first.')
            return
        self.model.remove(idx.row())
        self.flow_data.actor_model.refresh()

    def _deleteSelectedRows(self) -> None:
        rows = self._getSelectedRows()
        if not rows:
            return

        blocked_values: typing.List[str] = []
        deletable_rows: typing.List[int] = []
        for row in rows:
            if row < 0 or row >= len(self.model.l):
                continue
            value = self.model.l[row]
            if util.is_actor_string_in_use(self.flow_data.flow.flowchart.events, value):
                blocked_values.append(value.v)
            else:
                deletable_rows.append(row)

        for row in sorted(deletable_rows, reverse=True):
            self.model.remove(row)

        if deletable_rows:
            self.flow_data.actor_model.refresh()

        if blocked_values:
            q.QMessageBox.critical(
                self,
                'Cannot delete',
                'Some selected actions or queries cannot be deleted because they are in use:\n\n' +
                '\n'.join(blocked_values[:20])
            )

    def addActionBuilder(self, fn) -> None:
        self.action_builders.append(fn)

    def _getValues(self) -> typing.List[str]:
        return [item.v for item in self.model.l]

    def _getSelectedRows(self) -> typing.List[int]:
        smodel = self.lview.selectionModel()
        if not smodel:
            return []
        return sorted({index.row() for index in smodel.selectedRows()})

    def _getSelectedValues(self) -> typing.List[str]:
        rows = self._getSelectedRows()
        values = self._getValues()
        return [values[row] for row in rows if 0 <= row < len(values)]

    def _normalizeLines(self, text: str) -> typing.List[str]:
        values = []
        seen = set()
        for raw_line in text.splitlines():
            value = raw_line.strip()
            if not value or value in seen:
                continue
            seen.add(value)
            values.append(value)
        return values

    def _dedupeValues(self, values: typing.Iterable[str]) -> typing.List[str]:
        deduped = []
        seen = set()
        for value in values:
            if not value or value in seen:
                continue
            seen.add(value)
            deduped.append(value)
        return deduped

    def _replaceValues(self, values: typing.List[str]) -> None:
        if not hasattr(self, 'actor') or not getattr(self, 'actor'):
            return
        target_list = self.model.l
        target_list.clear()
        target_list.extend(StringHolder(value) for value in self._dedupeValues(values))
        self.model.set(target_list)
        self.flow_data.actor_model.refresh()
        self.flow_data.flowDataChanged.emit(FlowDataChangeReason.Actors)

    def _appendValues(self, values: typing.List[str]) -> None:
        if not hasattr(self, 'actor') or not getattr(self, 'actor'):
            return
        existing_values = self._getValues()
        existing_set = set(existing_values)
        values_to_add = [value for value in values if value not in existing_set]
        if not values_to_add:
            return

        insert_at = len(existing_values)
        self._replaceValues(existing_values + values_to_add)

        selection_model = self.lview.selectionModel()
        if not selection_model:
            return
        selection_model.clearSelection()
        for offset in range(len(values_to_add)):
            row = insert_at + offset
            if row >= self.model.rowCount(qc.QModelIndex()):
                break
            index = self.model.index(row, 0)
            selection_model.select(index, qc.QItemSelectionModel.Select | qc.QItemSelectionModel.Rows)
        if values_to_add and insert_at < self.model.rowCount(qc.QModelIndex()):
            self.lview.setCurrentIndex(self.model.index(insert_at, 0))

    def copyItems(self) -> None:
        values = self._getSelectedValues() or self._getValues()
        q.QApplication.clipboard().setText('\n'.join(values))

    def pasteItems(self) -> None:
        values = self._normalizeLines(q.QApplication.clipboard().text())
        if not values:
            q.QMessageBox.critical(self, f'Paste {self.label_str}', f'Failed to paste {self.label_str.lower()} from the clipboard.')
            return
        self._appendValues(values)

    def importItems(self) -> None:
        actor = getattr(self, 'actor', None)
        default_name = f'{actor.identifier.name if actor else self.label_str.lower()}.{self.label_str.lower()}.txt'
        path = q.QFileDialog.getOpenFileName(self, f'Import {self.label_str}...', default_name, 'Text (*.txt);;All files (*)')[0]
        if not path:
            return
        try:
            with open(path, 'rt', encoding='utf-8') as file:
                values = self._normalizeLines(file.read())
        except Exception as exc:
            q.QMessageBox.critical(self, f'Import {self.label_str}', f'Failed to import {self.label_str.lower()}.\n\n{exc}')
            return
        if not values:
            q.QMessageBox.critical(self, f'Import {self.label_str}', f'No {self.label_str.lower()} were found in the imported file.')
            return
        self._replaceValues(values)

    def exportItems(self) -> None:
        actor = getattr(self, 'actor', None)
        default_name = f'{actor.identifier.name if actor else self.label_str.lower()}.{self.label_str.lower()}.txt'
        path = q.QFileDialog.getSaveFileName(self, f'Export {self.label_str}...', default_name, 'Text (*.txt);;All files (*)')[0]
        if not path:
            return
        try:
            with open(path, 'wt', encoding='utf-8') as file:
                file.write('\n'.join(self._getValues()))
        except Exception as exc:
            q.QMessageBox.critical(self, f'Export {self.label_str}', f'Failed to export {self.label_str.lower()}.\n\n{exc}')

    def onContextMenu(self, pos) -> None:
        smodel = self.lview.selectionModel()
        if not smodel.selectedRows():
            return

        idx = smodel.selectedRows()[0]
        menu = q.QMenu()
        selected_rows = self._getSelectedRows()
        if len(selected_rows) > 1:
            menu.addAction(f'&Delete selected ({len(selected_rows)})', self._deleteSelectedRows)
        else:
            menu.addAction('&Delete', lambda: self.onRemove(idx))
        for builder in self.action_builders:
            builder(menu, idx)
        menu.exec_(self.sender().viewport().mapToGlobal(pos))

class ActorAIClassAddDialog(q.QDialog):
    def __init__(self, parent, model) -> None:
        super().__init__(parent, qc.Qt.WindowTitleHint | qc.Qt.WindowSystemMenuHint)
        self.setWindowTitle('Add an AI class')
        self.setMinimumWidth(350)

        ledit_hint = q.QLabel('Enter an AI class:')
        ledit_hint.setAlignment(qc.Qt.AlignCenter)
        self._ledit = q.QLineEdit()
        list_hint = q.QLabel('or select one:')
        list_hint.setAlignment(qc.Qt.AlignCenter)

        self._list = q.QListView()
        self._proxy_model = qc.QSortFilterProxyModel(self)
        self._proxy_model.setSourceModel(model)
        self._list.setModel(self._proxy_model)
        self._list.setEditTriggers(q.QAbstractItemView.NoEditTriggers)
        self._list.selectionModel().selectionChanged.connect(self._onSelectionChanged)
        self._list.doubleClicked.connect(lambda idx: self.accept())

        self._search_bar = SearchBar()
        self._search_bar.hide()
        self._search_bar.connectToFilterModel(self._proxy_model)
        self._search_bar.addFindShortcut(self)

        btn_box = q.QDialogButtonBox(q.QDialogButtonBox.Ok | q.QDialogButtonBox.Cancel);
        btn_box.accepted.connect(self.accept)
        btn_box.rejected.connect(self.reject)
        layout = q.QVBoxLayout(self)
        layout.addWidget(ledit_hint)
        layout.addWidget(self._ledit)
        layout.addWidget(list_hint)
        layout.addWidget(self._list)
        layout.addWidget(self._search_bar)
        layout.addWidget(btn_box)

    def accept(self) -> None:
        if not self.getText():
            q.QMessageBox.critical(self, self.windowTitle(), 'Please enter or select an AI class.')
            return
        super().accept()

    def getText(self) -> str:
        return self._ledit.text()

    def _onSelectionChanged(self, selected, deselected) -> None:
        if len(selected.indexes()) <= 0:
            return
        self._ledit.setText(selected.indexes()[0].data(qc.Qt.DisplayRole))

class ActorActionListView(ActorStringListView):
    def __init__(self, parent, model, flow_data) -> None:
        super().__init__(parent, 'Actions', model, flow_data)
        self.actor: typing.Optional[Actor] = None

    def setActor(self, actor: Actor) -> None:
        self.actor = actor

    def _getNewString(self) -> str:
        if not self.actor:
            return ''
        name = self.actor.identifier.name

        actions = []
        aiprog = ai.load_aiprog(name)
        if aiprog:
            actions = list(aiprog.actions.keys())
        else:
            json_actions = aj.load_actions(name)
            if json_actions:
                actions = list(json_actions)

        add_dialog = ActorAIClassAddDialog(self, qc.QStringListModel(actions, self))
        add_dialog.setWindowTitle(f'Add an action for {name}')
        ret = add_dialog.exec_()
        return add_dialog.getText() if ret else ''

class ActorQueryListView(ActorStringListView):
    def __init__(self, parent, model, flow_data) -> None:
        super().__init__(parent, 'Queries', model, flow_data)
        self.actor: typing.Optional[Actor] = None

    def setActor(self, actor: Actor) -> None:
        self.actor = actor

    def _getNewString(self) -> str:
        if not self.actor:
            return ''
        name = self.actor.identifier.name

        queries = []
        aiprog = ai.load_aiprog(name)
        if aiprog:
            queries = list(aiprog.queries.keys())
        else:
            json_queries = aj.load_queries(name)
            if json_queries:
                queries = list(json_queries)

        add_dialog = ActorAIClassAddDialog(self, qc.QStringListModel(queries, self))
        add_dialog.setWindowTitle(f'Add a query for {name}')
        ret = add_dialog.exec_()
        return add_dialog.getText() if ret else ''
