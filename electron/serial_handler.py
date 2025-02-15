import serial
from flask import Flask

app = Flask(__name__)
ser = serial.Serial('COM3', 9600)

@app.route('/open', methods=['POST'])
def open_door():
    ser.write(b'O')
    return {'status': 'success'}

if __name__ == '__main__':
    app.run(port=3000)