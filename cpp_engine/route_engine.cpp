#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <limits>
#include <queue>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "json.hpp"

using json = nlohmann::json;

struct Location {
    std::string id;
    double lat;
    double lon;
};

struct Edge {
    std::string to;
    double time;
    bool open;
    int roadIndex;
};

struct Node {
    std::string id;
    double cost;
    double priority;

    bool operator>(const Node& other) const {
        return priority > other.priority;
    }
};

class Router {
private:
    std::unordered_map<std::string, Location> locations;
    std::unordered_map<std::string, std::vector<Edge>> graph;
    double heuristicScale = 0.0;

    double haversine(const Location& a, const Location& b) const {
        const double R = 6371.0;
        const double rad = 3.141592653589793 / 180.0;

        double lat1 = a.lat * rad;
        double lat2 = b.lat * rad;
        double dlat = (b.lat - a.lat) * rad;
        double dlon = (b.lon - a.lon) * rad;

        double h = std::sin(dlat / 2) * std::sin(dlat / 2)
            + std::cos(lat1) * std::cos(lat2)
            * std::sin(dlon / 2) * std::sin(dlon / 2);
        if (h > 1.0) h = 1.0;

        return 2.0 * R * std::asin(std::sqrt(h));
    }

    double heuristic(const std::string& current, const std::string& destination) const {
        return haversine(locations.at(current), locations.at(destination)) * heuristicScale;
    }

public:
    void load(const std::string& filename) {
        std::ifstream file(filename);
        if (!file) {
            throw std::runtime_error("Cannot open graph.json");
        }

        json data;
        file >> data;

        for (const auto& item : data.at("locations")) {
            Location loc{
                item.at("id").get<std::string>(),
                item.at("lat").get<double>(),
                item.at("lon").get<double>()
            };
            locations[loc.id] = loc;
        }

        const auto& roads = data.at("roads");
        for (int idx = 0; idx < static_cast<int>(roads.size()); ++idx) {
            const auto& road = roads[idx];
            std::string from = road.at("from");
            std::string to = road.at("to");
            double time = road.at("travel_time");
            bool open = road.value("open", true);
            bool oneway = road.value("oneway", false);

            if (time < 0 || !locations.count(from) || !locations.count(to)) {
                throw std::runtime_error("Invalid road data");
            }

            graph[from].push_back({to, time, open, idx});
            if (!oneway) {
                graph[to].push_back({from, time, open, idx});
            }

            if (open) {
                double distance = haversine(locations.at(from), locations.at(to));
                if (distance > 0.0001) {
                    double ratio = time / distance;
                    if (heuristicScale == 0.0 || ratio < heuristicScale) {
                        heuristicScale = ratio;
                    }
                }
            }
        }
    }

    json findRoute(
        const std::string& start,
        const std::string& destination,
        const std::string& algorithm
    ) const {
        if (!locations.count(start) || !locations.count(destination)) {
            throw std::runtime_error("Invalid location ID");
        }
        if (algorithm != "astar" && algorithm != "dijkstra") {
            throw std::runtime_error("Invalid algorithm");
        }

        auto tStart = std::chrono::steady_clock::now();

        std::unordered_map<std::string, double> dist;
        std::unordered_map<std::string, std::string> parent;
        std::unordered_map<std::string, int> parentRoadIdx;

        for (const auto& item : locations) {
            dist[item.first] = std::numeric_limits<double>::infinity();
        }
        dist[start] = 0.0;

        std::priority_queue<Node, std::vector<Node>, std::greater<Node>> pq;
        pq.push({start, 0.0, 0.0});

        int nodesExplored = 0;

        while (!pq.empty()) {
            Node current = pq.top();
            pq.pop();

            if (current.cost > dist[current.id]) continue;
            ++nodesExplored;
            if (current.id == destination) break;

            auto it = graph.find(current.id);
            if (it == graph.end()) continue;

            for (const Edge& edge : it->second) {
                if (!edge.open) continue;

                double nextCost = current.cost + edge.time;
                if (nextCost < dist[edge.to]) {
                    dist[edge.to] = nextCost;
                    parent[edge.to] = current.id;
                    parentRoadIdx[edge.to] = edge.roadIndex;

                    double h = (algorithm == "astar")
                        ? heuristic(edge.to, destination)
                        : 0.0;

                    pq.push({edge.to, nextCost, nextCost + h});
                }
            }
        }

        auto tEnd = std::chrono::steady_clock::now();
        double elapsedMs = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

        if (!std::isfinite(dist[destination])) {
            return {
                {"status", "no_route"},
                {"algorithm", algorithm},
                {"nodes_explored", nodesExplored},
                {"compute_time_ms", std::round(elapsedMs * 1000.0) / 1000.0},
                {"path", json::array()},
                {"road_indices", json::array()},
                {"coordinates", json::array()}
            };
        }

        std::vector<std::string> path;
        std::vector<int> roadIndices;
        std::string current = destination;

        while (current != start) {
            path.push_back(current);
            if (!parent.count(current)) {
                throw std::runtime_error("Path reconstruction failed");
            }
            roadIndices.push_back(parentRoadIdx.at(current));
            current = parent.at(current);
        }

        path.push_back(start);
        std::reverse(path.begin(), path.end());
        std::reverse(roadIndices.begin(), roadIndices.end());

        json coordinates = json::array();
        for (const auto& id : path) {
            const auto& loc = locations.at(id);
            coordinates.push_back({
                {"id", id},
                {"latitude", loc.lat},
                {"longitude", loc.lon}
            });
        }

        return {
            {"status", "route_found"},
            {"algorithm", algorithm},
            {"nodes_explored", nodesExplored},
            {"compute_time_ms", std::round(elapsedMs * 1000.0) / 1000.0},
            {"path", path},
            {"road_indices", roadIndices},
            {"coordinates", coordinates},
            {"estimated_travel_time", std::round(dist[destination] * 100.0) / 100.0}
        };
    }
};

int main(int argc, char* argv[]) {
    try {
        if (argc != 5) {
            throw std::runtime_error(
                "Usage: route_engine.exe graph.json start destination algorithm"
            );
        }

        Router router;
        router.load(argv[1]);

        json result = router.findRoute(argv[2], argv[3], argv[4]);
        std::cout << result.dump() << std::endl;
        return 0;
    }
    catch (const std::exception& e) {
        std::cout << json({
            {"status", "error"},
            {"message", e.what()}
        }).dump() << std::endl;
        return 1;
    }
}
