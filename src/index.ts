import express, { Response, Request } from 'express';
import path from 'path';
import SocketIO from './services/socketIO';
import * as dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT;

const app = express();
app.use(express.json());

app.use('/', express.static(path.join(__dirname, 'static')));

// @ts-ignore:
app.get('/init', (req: Request, res: Response) => {
  return res.status(200).send(true);
});

const initServer = () => {
  const server = app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
    SocketIO.socketInit(server);
  });
};

initServer();
