import dataclasses,functools


@dataclasses.dataclass
class Father(object):
    name: str
    gender: str = '男'

    def walk(self):
        print(f'{self.name}在走')
    def smoking(self):
        print(f'{self.name}在吸烟')
class Mother:
    name: str
    gender: str = '女'
class Son(Father,Mother):
    def smoking(self):
        print(f'{self.name}不吸烟')

sam = Son('Sam')
sam.walk()
sam.smoking()
print(sam.gender)
sam.smoking()
