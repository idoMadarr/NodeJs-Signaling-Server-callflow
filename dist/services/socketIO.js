"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const socket_io_1 = require("socket.io");
let io;
const callerIdToSocketId = new Map();
exports.default = {
    socketInit: (server) => {
        io = new socket_io_1.Server(server, { pingInterval: 5000, pingTimeout: 5000 });
        console.log('Socket Init');
        io.use((socket, next) => {
            const callerId = socket.handshake.query.callerId;
            // @ts-ignore:
            socket.callerId = callerId;
            callerIdToSocketId.set(callerId, socket.id); // Map callerId to socket.id
            next();
        });
        io.on('connection', socket => {
            console.log(socket.id, typeof socket.id, callerIdToSocketId);
            // step 1: Sending the offer to the callee id
            socket.on('call', data => {
                const { calleeId, rtcMessage } = data;
                const calleeSocketId = callerIdToSocketId.get(calleeId);
                if (calleeSocketId) {
                    io.to(calleeSocketId).emit('newCall', {
                        // @ts-ignore:
                        callerId: socket.callerId,
                        rtcMessage: rtcMessage,
                    });
                }
            });
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
            socket.on('endCall', data => {
                const { calleeId } = data;
                const callerSocketId = callerIdToSocketId.get(calleeId);
                if (callerSocketId) {
                    io.to(callerSocketId).emit('callEnded');
                }
            });
            socket.on('disconnect', () => {
                // @ts-ignore:
                callerIdToSocketId.delete(socket.callerId);
            });
        });
    },
    getIO: () => {
        if (io)
            return io;
        return console.log('Socket.io is not initialized!');
    },
};
