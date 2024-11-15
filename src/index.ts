import express from 'express';
import path from 'path';
import SocketIO from './services/socketIO';

const PORT = process.env.PORT || 8000;

const app = express();
app.use(express.json());

app.use('/', express.static(path.join(__dirname, 'static')));

const initServer = () => {
  const server = app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
    SocketIO.socketInit(server);
  });
};

initServer();
