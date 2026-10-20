class A:
    def __bytes__(self):
        print('bytes')
        return bytes([0,1,2,3])
print(bytes(A()))
