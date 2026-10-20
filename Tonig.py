import dataclasses,functools


@dataclasses.dataclass
class SweetPotato(object):
    cook_time: int = 0
    cook_state: str = "raw"
    condiments: list = dataclasses.field(default_factory=list)


    def cook(self,time):
        self.cook_time += time
        if self.cook_time < 0:
            print("时间不能小于0")
        elif 3 <= self.cook_time <= 7:
            self.cook_state = "半生不熟"
        elif 7 < self.cook_time <= 10:
            self.cook_state = "熟"
        elif self.cook_time > 10:
            self.cook_state = "过熟"
        else:
            self.cook_state = "raw"
    def add_condiment(self,condiment):
        self.condiments.append(condiment)

if __name__ == "__main__":
    dg = SweetPotato()
    dg.cook(5)
    dg.add_condiment("盐")
    print(dg.condiments)
    print(dg.cook_state)
    print(dg)

