"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const socket_io_1 = require("socket.io");
let io;
const callerIdToSocketId = new Map();
exports.default = {
    socketInit: (server) => {
        io = new socket_io_1.Server(server, { pingInterval: 5000, pingTimeout: 5000 });
        console.log('Socket Init');
        io.on('connection', socket => {
            // Map callerId to socket.id
            const callerId = socket.handshake.query.callerId;
            callerIdToSocketId.set(callerId, socket.id);
            socket.userId = callerId;
            // Sending the offer to the callee id
            socket.on('call', data => {
                const { callerId, calleeId, offer, netInfo } = data;
                const calleeSocketId = callerIdToSocketId.get(calleeId);
                if (calleeSocketId) {
                    io.to(calleeSocketId).emit('newCall', {
                        callerId: callerId,
                        offer: offer,
                        netInfo: netInfo,
                    });
                }
            });
            // Sending answer back to caller
            socket.on('answerCall', data => {
                const { callerId, rtcMessage } = data;
                const callerSocketId = callerIdToSocketId.get(callerId);
                if (callerSocketId) {
                    io.to(callerSocketId).emit('callAnswered', {
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
                const { otherUserId, rtcMessage } = data;
                const callerSocketId = callerIdToSocketId.get(otherUserId);
                if (callerSocketId) {
                    io.to(callerSocketId).emit('ICEcandidate', {
                        sender: socket.userId,
                        rtcMessage: rtcMessage,
                    });
                }
            });
            // Sending end call to the participant
            socket.on('endCall', data => {
                const { otherUserId } = data;
                const callerSocketId = callerIdToSocketId.get(otherUserId);
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
            socket.on('unreachableCall', data => {
                const { callerId } = data;
                const callerSocketId = callerIdToSocketId.get(callerId);
                if (callerSocketId) {
                    io.to(callerSocketId).emit('callEnded');
                }
            });
            socket.on('disconnect', () => {
                callerIdToSocketId.delete(socket.userId);
            });
        });
    },
    getIO: () => {
        if (io)
            return io;
        return console.log('Socket.io is not initialized!');
    },
};
