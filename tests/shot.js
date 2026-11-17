const app = window.app;
const theme = location.hash.slice(1);
app.settings.sound = false;
if (theme) app.settings.theme = theme;
app.applySettings();
app.startComputer('10+5', 'w', 2);
app.engine.stop();
app.engineBusy = false;
app.mode = 'local';
for (const s of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Nxd5', 'Nxf7', 'Kxf7', 'Qf3+']) {
  const m = app.game.chess.moves({ verbose: true }).find((x) => x.san === s);
  app.playMove(m, { animate: false });
}
app.mode = 'computer';
app.names = { w: 'Alex', b: 'Computer (Medium)' };
app.render();
app.mode = 'local';
app.board.select('f7');
app.mode = 'computer';
