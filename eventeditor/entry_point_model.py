import re
import typing

from evfl import EventFlow
from evfl.event import SubFlowEvent
from evfl.entry_point import EntryPoint
import PyQt5.QtCore as qc # type: ignore
import PyQt5.QtGui as qg # type: ignore
import PyQt5.QtWidgets as q # type: ignore

class EntryPointModel(qc.QAbstractListModel):
    HiddenRole = qc.Qt.UserRole + 1
    visibilityChanged = qc.pyqtSignal()

    def __init__(self, *kwargs) -> None:
        super().__init__(*kwargs)
        self.flow: typing.Optional[EventFlow] = None
        self.l: typing.List[EntryPoint] = []
        self.hidden_names: typing.Set[str] = set()
        self.visible_icon = qg.QIcon()
        self.hidden_icon = qg.QIcon()

    def setVisibilityIcons(self, visible_icon: qg.QIcon, hidden_icon: qg.QIcon) -> None:
        self.visible_icon = visible_icon
        self.hidden_icon = hidden_icon
        if self.l:
            self.dataChanged.emit(self.createIndex(0, 0), self.createIndex(len(self.l) - 1, 0))

    def isHiddenRow(self, row: int) -> bool:
        return 0 <= row < len(self.l) and self.l[row].name in self.hidden_names

    def hiddenEntryPointNames(self) -> typing.Set[str]:
        return set(self.hidden_names)

    def toggleRowVisibility(self, row: int) -> bool:
        if not (0 <= row < len(self.l)):
            return False
        entry_name = self.l[row].name
        if entry_name in self.hidden_names:
            self.hidden_names.remove(entry_name)
        else:
            self.hidden_names.add(entry_name)
        index = self.createIndex(row, 0)
        self.dataChanged.emit(index, index, [qc.Qt.DecorationRole, self.HiddenRole])
        self.visibilityChanged.emit()
        return True

    def toggleRowsVisibility(self, rows: typing.Iterable[int]) -> bool:
        valid_rows = sorted({row for row in rows if 0 <= row < len(self.l)})
        if not valid_rows:
            return False
        for row in valid_rows:
            entry_name = self.l[row].name
            if entry_name in self.hidden_names:
                self.hidden_names.remove(entry_name)
            else:
                self.hidden_names.add(entry_name)
        self.dataChanged.emit(
            self.createIndex(valid_rows[0], 0),
            self.createIndex(valid_rows[-1], 0),
            [qc.Qt.DecorationRole, self.HiddenRole],
        )
        self.visibilityChanged.emit()
        return True

    def setRowsHidden(self, rows: typing.Iterable[int], hidden: bool) -> bool:
        valid_rows = sorted({row for row in rows if 0 <= row < len(self.l)})
        if not valid_rows:
            return False
        changed = False
        for row in valid_rows:
            entry_name = self.l[row].name
            if hidden:
                if entry_name not in self.hidden_names:
                    self.hidden_names.add(entry_name)
                    changed = True
            else:
                if entry_name in self.hidden_names:
                    self.hidden_names.remove(entry_name)
                    changed = True
        if not changed:
            return False
        self.dataChanged.emit(
            self.createIndex(valid_rows[0], 0),
            self.createIndex(valid_rows[-1], 0),
            [qc.Qt.DecorationRole, self.HiddenRole],
        )
        self.visibilityChanged.emit()
        return True

    def append(self, entry_point: EntryPoint) -> bool:
        self.beginInsertRows(qc.QModelIndex(), len(self.l), len(self.l))
        self.l.append(entry_point)
        self.endInsertRows()
        return True

    def removeRow(self, row: int) -> bool:
        self.beginRemoveRows(qc.QModelIndex(), row, row)
        self.l.pop(row)
        self.endRemoveRows()
        return True

    def flags(self, index: qc.QModelIndex) -> qc.Qt.ItemFlags:
        return qc.Qt.ItemIsEditable | super().flags(index)

    def has(self, name: str) -> bool:
        return any(entry.name == name for entry in self.l)

    def set(self, flow) -> None:
        self.beginResetModel()
        self.flow = flow
        self.l = self.flow.flowchart.entry_points if self.flow and self.flow.flowchart else []
        self.hidden_names = {name for name in self.hidden_names if any(entry.name == name for entry in self.l)}
        self.endResetModel()
        self.visibilityChanged.emit()

    def _dialog_parent(self) -> typing.Optional[q.QWidget]:
        active_window = q.QApplication.activeWindow()
        return active_window if isinstance(active_window, q.QWidget) else None

    def rowCount(self, parent) -> int:
        return len(self.l)

    def setData(self, index: qc.QModelIndex, value, role) -> bool:
        if role == self.HiddenRole and index.isValid():
            return self.toggleRowVisibility(index.row())
        if role != qc.Qt.EditRole or not index.isValid():
            return False
        if not isinstance(value, str) or not value or re.match('^Event(\d)+$', value) is not None or value == '*j32':
            q.QMessageBox.critical(self._dialog_parent(), 'Cannot rename', f'"{value}" is an invalid entry point name.')
            return False
        old_name = self.l[index.row()].name
        if old_name == value:
            return False
        if self.has(value):
            q.QMessageBox.critical(self._dialog_parent(), 'Cannot rename', f'"{value}" is already used by another entry point.')
            return False

        updated_subflows = 0
        if self.flow and self.flow.flowchart:
            matching_subflows = []
            current_flow_names = {self.flow.name, self.flow.flowchart.name}
            for event in self.flow.flowchart.events:
                if not event or not isinstance(event.data, SubFlowEvent):
                    continue
                if event.data.entry_point_name != old_name:
                    continue
                target_flow = event.data.res_flowchart_name or ''
                if target_flow and target_flow not in current_flow_names:
                    continue
                matching_subflows.append(event)

            if matching_subflows:
                ret = q.QMessageBox.question(
                    self._dialog_parent(),
                    'Update subflow references',
                    f'Found {len(matching_subflows)} subflow reference(s) pointing to "{old_name}".\n\n'
                    f'Update them to "{value}" as well?',
                    q.QMessageBox.Yes | q.QMessageBox.No,
                    q.QMessageBox.Yes,
                )
                if ret == q.QMessageBox.Yes:
                    for event in matching_subflows:
                        event.data.entry_point_name = value
                    updated_subflows = len(matching_subflows)

        if old_name in self.hidden_names:
            self.hidden_names.remove(old_name)
            self.hidden_names.add(value)
        self.l[index.row()].name = value
        self.dataChanged.emit(index, index)
        if updated_subflows:
            top_left = self.createIndex(0, 0)
            bottom_right = self.createIndex(len(self.l) - 1, 0)
            self.dataChanged.emit(top_left, bottom_right)
        self.visibilityChanged.emit()
        return True

    def data(self, index: qc.QModelIndex, role):
        if role == qc.Qt.UserRole:
            return self.l[index.row()]
        if role == self.HiddenRole:
            return self.isHiddenRow(index.row())
        if role == qc.Qt.DecorationRole:
            return self.hidden_icon if self.isHiddenRow(index.row()) else self.visible_icon
        if role == qc.Qt.DisplayRole or role == qc.Qt.EditRole or role == qc.Qt.ToolTipRole:
            return self.l[index.row()].name
        return qc.QVariant()
