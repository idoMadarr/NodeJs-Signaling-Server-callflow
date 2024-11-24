import { Server } from 'socket.io';

let io: Server;

const callerIdToSocketId = new Map<string, string>();

export default {
  socketInit: (server: any) => {
    io = new Server(server, { pingInterval: 5000, pingTimeout: 5000 });
    console.log('Socket Init');

    // Map callerId to socket.id
    io.use((socket, next) => {
      const callerId = socket.handshake.query.callerId as string;
      // @ts-ignore:
      socket.callerId = callerId;
      callerIdToSocketId.set(callerId, socket.id);
      next();
    });

    io.on('connection', socket => {
      console.log(socket.id);

      // Sending the offer to the callee id
      socket.on('call', data => {
        const { calleeId, rtcMessage } = data;
        const calleeSocketId = callerIdToSocketId.get(calleeId);

        if (calleeSocketId) {
          io.to(calleeSocketId).emit('newCall', {
            // @ts-ignore:
            callerId: socket.callerId!,
            rtcMessage: rtcMessage,
          });
        }
      });

      // Sending answer back to caller
      socket.on('answerCall', data => {
        const { callerId, rtcMessage } = data;
        const callerSocketId = callerIdToSocketId.get(callerId);

        if (callerSocketId) {
          io.to(callerSocketId).emit('callAnswered', {
            // @ts-ignore:
            callee: socket.callerId,
            rtcMessage: rtcMessage,
          });
        }
      });

      // Sending reject to answer back to caller
      socket.on('rejectCall', data => {
        const { calleeId } = data;
        const calleeSocketId = callerIdToSocketId.get(calleeId);

        if (calleeSocketId) {
          io.to(calleeSocketId).emit('callRejected');
        }
      });

      // Establish peer connection
      socket.on('ICEcandidate', data => {
        const { calleeId, rtcMessage } = data;
        const callerSocketId = callerIdToSocketId.get(calleeId);

        if (callerSocketId) {
          io.to(callerSocketId).emit('ICEcandidate', {
            // @ts-ignore:
            sender: socket.callerId,
            rtcMessage: rtcMessage,
          });
        }
      });

      // Sending end call to the participant
      socket.on('endCall', data => {
        const { calleeId } = data;
        const callerSocketId = callerIdToSocketId.get(calleeId);

        if (callerSocketId) {
          io.to(callerSocketId).emit('callEnded');
        }
      });

      // Sending camera status (on/off) to the participant
      socket.on('setCamera', data => {
        const { otherUserId } = data;
        const callerSocketId = callerIdToSocketId.get(otherUserId);

        if (callerSocketId) {
          io.to(callerSocketId).emit('toggleCamera');
        }
      });

      // Sending microphone status (mute/voice) to the participant
      socket.on('setMicrophone', data => {
        const { otherUserId } = data;
        const callerSocketId = callerIdToSocketId.get(otherUserId);

        if (callerSocketId) {
          io.to(callerSocketId).emit('toogleMicrophone');
        }
      });

      socket.on('disconnect', () => {
        // @ts-ignore:
        callerIdToSocketId.delete(socket.callerId);
      });
    });
  },
  getIO: () => {
    if (io) return io;
    return console.log('Socket.io is not initialized!');
  },
};
