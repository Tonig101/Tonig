class A:
    def who(self):
        return "A"

class B(A):
    def who(self):
        return "B"

class C(A):
    def who(self):
        return "C"

class D(B, C):
    pass

print(D().who())   # B
print(D.__mro__)   # (D, B, C, A, object)
# 多继承时， 会先调用第一个父类的方法，如果第一个父类的方法没有返回值，会继续调用第二个父类的方法，以此类推。
