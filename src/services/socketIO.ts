import { Server } from 'socket.io';

let io: Server;

export default {
  socketInit: (server: any) => {
    io = new Server(server, { pingInterval: 5000, pingTimeout: 5000 });
    console.log('Socket Init');

    io.use((socket, next) => {
      console.log('hi');
      if (socket.handshake.query) {
        let callerId = socket.handshake.query.callerId;
        // @ts-ignore
        socket.user = callerId;
        next();
      }
    });

    io.on('connection', socket => {
      //   console.log(socket.user, 'Connected');
      console.log(socket.id, 'Connected2');

      socket.on('call', data => {
        let calleeId = data.calleeId;
        let rtcMessage = data.rtcMessage;

        socket.to(calleeId).emit('newCall', {
          callerId: socket.id,
          rtcMessage: rtcMessage,
        });
      });

      socket.on('answerCall', data => {
        let callerId = data.callerId;
        let rtcMessage = data.rtcMessage;

        socket.to(callerId).emit('callAnswered', {
          callee: socket.id,
          rtcMessage: rtcMessage,
        });
      });

      socket.on('ICEcandidate', data => {
        console.log('ICEcandidate data.calleeId', data.calleeId);
        let calleeId = data.calleeId;
        let rtcMessage = data.rtcMessage;

        socket.to(calleeId).emit('ICEcandidate', {
          sender: socket.id,
          rtcMessage: rtcMessage,
        });
      });
    });
  },
  getIO: () => {
    if (io) return io;
    return console.log('Socket.io is not initialized!');
  },
};
