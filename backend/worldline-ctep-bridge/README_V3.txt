POSPOINT RX5000 TEST BRIDGE V3 - JAVA 11

DOEL
Deze build test CancelRetailTransaction als cancel-methode tijdens een actieve SaleTransaction.

TEST
1. Sluit de oude bridge.
2. Start START_TEST_BRIDGE.bat.
3. Controleer http://127.0.0.1:3210/status
4. Start een SALE van EUR 0,10.
5. Zodra het betaalvenster op de RX5000 zichtbaar is, druk CANCEL.
6. Kijk fysiek naar de RX5000.

GESLAAGD
Het betaalvenster moet op de RX5000 stoppen/verdwijnen.

BELANGRIJKE LOGREGELS
CANCEL requested txId=...
CancelRetailTransaction sending txId=...
CancelRetailTransaction sent txId=...
CancelRetailTransaction result txId=... error=...

Deze test gebruikt GEEN resetTransaction() voor /cancel.
